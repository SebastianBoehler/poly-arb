/**
 * Ladder Accumulation Strategy (C++)
 *
 * Implements the same strategy as index.ts:
 * - Sequential leg placement (YES first, then NO when profitable)
 * - Averaging into positions over time
 * - Per-symbol budget tracking
 * - Real-time WebSocket price streaming
 *
 * Build: cmake --build build --target ladder_accumulation
 * Run: PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/ladder_accumulation
 */

#include "order_signer.hpp"
#include "http_client.hpp"
#include "websocket_client.hpp"
#include <nlohmann/json.hpp>
#include <iostream>
#include <cstdlib>
#include <chrono>
#include <iomanip>
#include <map>
#include <set>
#include <atomic>
#include <thread>
#include <mutex>
#include <cmath>
#include <csignal>

using json = nlohmann::json;
using namespace polymarket;

// Constants
const std::string CLOB_API = "https://clob.polymarket.com";
const std::string GAMMA_API = "https://gamma-api.polymarket.com";
const std::string WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const std::string NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const std::string CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const double FEE = 0.02;

// Global state
std::atomic<bool> g_running{true};
std::mutex g_mutex;

// Market state tracking
struct MarketState
{
    std::string slug;
    std::string symbol;
    std::string title;
    std::string token_yes;
    std::string token_no;
    std::string condition_id;
    bool neg_risk = false;
    uint64_t expiry_ts = 0;

    // Prices
    double best_ask_yes = 0.99;
    double best_ask_no = 0.99;

    // Position tracking
    double total_shares_yes = 0;
    double total_cost_yes = 0;
    double total_shares_no = 0;
    double total_cost_no = 0;
    int entry_count = 0;
    int ladder_level = 0;
    double last_entry_combined = 2.0;
    double lowest_combined = 2.0;
    double highest_combined = 0.0;

    // Metrics
    double avg_yes() const { return total_shares_yes > 0 ? total_cost_yes / total_shares_yes : 0; }
    double avg_no() const { return total_shares_no > 0 ? total_cost_no / total_shares_no : 0; }
    double combined() const { return avg_yes() + avg_no(); }
    double payout() const { return 1.0 - FEE * (1.0 - std::max(avg_yes(), avg_no())); }
    double edge() const { return payout() - combined(); }
    bool profitable() const { return edge() > 0; }
};

struct LegFills
{
    double yes_shares = 0;
    double yes_cost = 0;
    double no_shares = 0;
    double no_cost = 0;
    std::string pending_side; // "yes", "no", or ""
};

// Configuration
struct Config
{
    double base_size_usdc = 5.0;
    double size_multiplier = 1.5;
    double per_symbol_budget_usdc = 100.0;
    double max_initial_combined = 1.01;
    double ladder_step = 0.01;
    double min_usd_per_leg = 0.1;
    bool dry_run = true;
};

// Crypto tickers to track (same as TypeScript)
const std::vector<std::string> CRYPTO_TICKERS = {"btc", "eth", "xrp", "sol", "doge", "bnb", "ada", "avax", "matic", "link", "dot", "ltc"};

std::vector<uint64_t> get_15m_timestamps(int count)
{
    uint64_t now = static_cast<uint64_t>(std::time(nullptr));
    uint64_t interval = 15 * 60;
    uint64_t current_window = (now / interval) * interval;
    std::vector<uint64_t> timestamps;
    for (int i = 0; i < count; i++)
    {
        timestamps.push_back(current_window + interval * i);
    }
    return timestamps;
}

// Global tracking
std::map<std::string, MarketState> g_markets;       // slug -> state
std::map<std::string, std::string> g_token_to_slug; // token_id -> slug
std::map<std::string, std::string> g_token_to_side; // token_id -> "yes"/"no"
std::map<std::string, LegFills> g_fills;            // slug -> fills
std::map<std::string, double> g_symbol_spend;       // symbol -> total spent
std::set<std::string> g_all_tokens;

// Stats
int g_total_orders = 0;
double g_total_spent = 0;
int g_profitable_positions = 0;

void signal_handler(int)
{
    g_running = false;
}

std::string format_duration(int64_t ms)
{
    int64_t secs = ms / 1000;
    int64_t mins = secs / 60;
    int64_t hours = mins / 60;
    secs %= 60;
    mins %= 60;

    std::ostringstream oss;
    if (hours > 0)
        oss << hours << "h ";
    if (mins > 0 || hours > 0)
        oss << mins << "m ";
    oss << secs << "s";
    return oss.str();
}

std::string format_usd(double val, bool with_sign = false)
{
    std::ostringstream oss;
    if (with_sign && val >= 0)
        oss << "+";
    oss << "$" << std::fixed << std::setprecision(2) << val;
    return oss.str();
}

void try_entry(MarketState &m, const Config &cfg, OrderSigner &signer,
               HttpClient &http, const ApiCredentials &creds,
               const std::string &funder_address)
{
    std::lock_guard<std::mutex> lock(g_mutex);

    if (m.best_ask_yes <= 0 || m.best_ask_no <= 0)
        return;

    double current_combined = m.best_ask_yes + m.best_ask_no;
    if (current_combined < m.lowest_combined)
        m.lowest_combined = current_combined;
    if (current_combined > m.highest_combined)
        m.highest_combined = current_combined;

    double current_symbol_spend = g_symbol_spend[m.symbol];
    double remaining_budget = cfg.per_symbol_budget_usdc - current_symbol_spend;
    if (remaining_budget < cfg.min_usd_per_leg)
        return;

    LegFills &fills = g_fills[m.slug];

    double avg_yes = fills.yes_shares > 0 ? fills.yes_cost / fills.yes_shares : 0;
    double avg_no = fills.no_shares > 0 ? fills.no_cost / fills.no_shares : 0;

    std::string side;
    double amount_usd = cfg.min_usd_per_leg;

    const int max_first_side_orders = 2;
    int first_side_count = 0;
    if (fills.yes_shares > 0 && fills.no_shares == 0)
    {
        first_side_count = static_cast<int>(std::ceil(fills.yes_cost / cfg.min_usd_per_leg));
    }
    else if (fills.no_shares > 0 && fills.yes_shares == 0)
    {
        first_side_count = static_cast<int>(std::ceil(fills.no_cost / cfg.min_usd_per_leg));
    }

    if (fills.yes_shares == 0 && fills.no_shares == 0)
    {
        // First entry - place on YES if combined <= threshold
        if (current_combined <= cfg.max_initial_combined)
        {
            side = "yes";
            amount_usd = cfg.min_usd_per_leg;
            m.ladder_level = 1;
        }
    }
    else if (fills.yes_shares > 0 && fills.no_shares == 0 && first_side_count < max_first_side_orders)
    {
        // Can still average down YES before needing NO
        if (m.best_ask_yes < avg_yes)
        {
            side = "yes";
            amount_usd = cfg.min_usd_per_leg;
        }
        else
        {
            // Try to get NO at profitable price
            double max_no_price = 1.0 - avg_yes;
            if (m.best_ask_no <= max_no_price)
            {
                side = "no";
                amount_usd = std::min(fills.yes_cost, remaining_budget);
                if (amount_usd < cfg.min_usd_per_leg)
                    amount_usd = cfg.min_usd_per_leg;
            }
            else
            {
                fills.pending_side = "no";
            }
        }
    }
    else if (fills.yes_shares > 0 && fills.no_shares == 0)
    {
        // Have YES, need NO
        double max_no_price = 1.0 - avg_yes;
        if (m.best_ask_no <= max_no_price)
        {
            side = "no";
            amount_usd = std::min(fills.yes_cost, remaining_budget);
            if (amount_usd < cfg.min_usd_per_leg)
                amount_usd = cfg.min_usd_per_leg;
        }
        else
        {
            fills.pending_side = "no";
        }
    }
    else if (fills.no_shares > 0 && fills.yes_shares == 0)
    {
        // Have NO, need YES
        double max_yes_price = 1.0 - avg_no;
        if (m.best_ask_yes <= max_yes_price)
        {
            side = "yes";
            amount_usd = std::min(fills.no_cost, remaining_budget);
            if (amount_usd < cfg.min_usd_per_leg)
                amount_usd = cfg.min_usd_per_leg;
        }
        else
        {
            fills.pending_side = "yes";
        }
    }
    else
    {
        // Have both sides - check if balanced and can improve
        double current_avg_combined = avg_yes + avg_no;
        double cost_imbalance = std::abs(fills.yes_cost - fills.no_cost);
        double min_cost = std::min(fills.yes_cost, fills.no_cost);

        // Rebalance if > 10% difference
        if (cost_imbalance > min_cost * 0.1)
        {
            if (fills.yes_cost > fills.no_cost)
            {
                double max_no_price = 1.0 - avg_yes;
                if (m.best_ask_no <= max_no_price)
                {
                    side = "no";
                    amount_usd = std::min(fills.yes_cost - fills.no_cost, remaining_budget);
                    if (amount_usd < cfg.min_usd_per_leg)
                        amount_usd = cfg.min_usd_per_leg;
                }
            }
            else
            {
                double max_yes_price = 1.0 - avg_no;
                if (m.best_ask_yes <= max_yes_price)
                {
                    side = "yes";
                    amount_usd = std::min(fills.no_cost - fills.yes_cost, remaining_budget);
                    if (amount_usd < cfg.min_usd_per_leg)
                        amount_usd = cfg.min_usd_per_leg;
                }
            }
        }
        else if (current_avg_combined >= 1.0)
        {
            // Balanced but combined >= 1, average down
            double yes_improvement = avg_yes - m.best_ask_yes;
            double no_improvement = avg_no - m.best_ask_no;
            if (yes_improvement > no_improvement && yes_improvement > 0)
            {
                side = "yes";
                amount_usd = cfg.min_usd_per_leg;
            }
            else if (no_improvement > 0)
            {
                side = "no";
                amount_usd = cfg.min_usd_per_leg;
            }
        }
        else
        {
            // Combined < 1 and balanced - check for ladder reload
            double combined_drop = m.last_entry_combined - current_combined;
            if (combined_drop >= cfg.ladder_step && current_combined <= cfg.max_initial_combined)
            {
                m.ladder_level++;
                side = "yes";
                amount_usd = cfg.base_size_usdc * std::pow(cfg.size_multiplier, m.ladder_level - 1);
            }
        }
    }

    if (side.empty())
        return;

    // Cap amount to remaining budget
    amount_usd = std::min(amount_usd, remaining_budget);
    if (amount_usd < cfg.min_usd_per_leg)
        return;

    double price = (side == "yes") ? m.best_ask_yes : m.best_ask_no;
    double shares = amount_usd / price;

    std::cout << "\n    ENTRY: " << m.slug.substr(0, 40) << "\n";
    std::cout << "       Side: " << side << " @ " << std::fixed << std::setprecision(4) << price;
    std::cout << " | $" << std::setprecision(2) << amount_usd << " = " << std::setprecision(4) << shares << " shares\n";

    if (cfg.dry_run)
    {
        std::cout << "       [DRY RUN] Would place order\n";
    }
    else
    {
        // Place actual order
        std::string token_id = (side == "yes") ? m.token_yes : m.token_no;
        std::string exchange_addr = m.neg_risk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

        OrderData order;
        order.maker = funder_address;
        order.taker = "0x0000000000000000000000000000000000000000";
        order.token_id = token_id;
        order.maker_amount = to_wei(amount_usd, 6);
        order.taker_amount = to_wei(shares, 6);
        order.side = OrderSide::BUY;
        order.fee_rate_bps = "0";
        order.nonce = "0";
        order.signer = signer.address();
        order.expiration = "0";
        order.signature_type = (funder_address != signer.address())
                                   ? SignatureType::POLY_GNOSIS_SAFE
                                   : SignatureType::EOA;

        auto signed_order = signer.sign_order(order, exchange_addr);

        // Build payload
        nlohmann::ordered_json payload;
        nlohmann::ordered_json order_obj;
        order_obj["salt"] = std::stoll(signed_order.salt);
        order_obj["maker"] = signed_order.maker;
        order_obj["signer"] = signed_order.signer;
        order_obj["taker"] = signed_order.taker;
        order_obj["tokenId"] = signed_order.token_id;
        order_obj["makerAmount"] = signed_order.maker_amount;
        order_obj["takerAmount"] = signed_order.taker_amount;
        order_obj["side"] = "BUY";
        order_obj["expiration"] = signed_order.expiration;
        order_obj["nonce"] = signed_order.nonce;
        order_obj["feeRateBps"] = signed_order.fee_rate_bps;
        order_obj["signatureType"] = static_cast<int>(signed_order.signature_type);
        order_obj["signature"] = signed_order.signature;
        payload["order"] = order_obj;
        payload["owner"] = creds.api_key;
        payload["orderType"] = "FOK";

        std::string body_str = payload.dump();
        auto l2 = signer.generate_l2_headers(creds, "POST", "/order", body_str, funder_address);

        std::map<std::string, std::string> headers;
        headers["Content-Type"] = "application/json";
        headers["POLY_ADDRESS"] = l2.poly_address;
        headers["POLY_SIGNATURE"] = l2.poly_signature;
        headers["POLY_TIMESTAMP"] = l2.poly_timestamp;
        headers["POLY_API_KEY"] = l2.poly_api_key;
        headers["POLY_PASSPHRASE"] = l2.poly_passphrase;

        auto response = http.post("/order", body_str, headers);

        if (response.ok())
        {
            auto result = json::parse(response.body);
            bool success = result.value("success", false);
            std::string status = result.value("status", "unknown");

            if (success && (status == "matched" || status == "MATCHED"))
            {
                std::cout << "       ✅ FILLED\n";
                g_total_orders++;
                g_total_spent += amount_usd;
            }
            else
            {
                std::cout << "       ⚠️ " << status << "\n";
                return; // Don't update state if not filled
            }
        }
        else
        {
            std::cout << "       ❌ Failed: " << response.body.substr(0, 100) << "\n";
            return;
        }
    }

    // Update fills
    if (side == "yes")
    {
        fills.yes_shares += shares;
        fills.yes_cost += amount_usd;
    }
    else
    {
        fills.no_shares += shares;
        fills.no_cost += amount_usd;
    }
    fills.pending_side = "";

    g_symbol_spend[m.symbol] = current_symbol_spend + amount_usd;

    // Update market state
    m.total_shares_yes = fills.yes_shares;
    m.total_cost_yes = fills.yes_cost;
    m.total_shares_no = fills.no_shares;
}

void fetch_crypto_15m_markets(HttpClient &gamma_http, HttpClient &clob_http)
{
    std::lock_guard<std::mutex> lock(g_mutex);

    // Get next 3 timestamp windows (same as TypeScript)
    auto timestamps = get_15m_timestamps(3);
    int new_markets = 0;

    // Fetch each ticker + timestamp combination
    for (const auto &ticker : CRYPTO_TICKERS)
    {
        for (const auto &ts : timestamps)
        {
            std::string slug = ticker + "-updown-15m-" + std::to_string(ts);

            // Skip if already have this market
            if (g_markets.count(slug))
                continue;

            auto response = gamma_http.get("/events?slug=" + slug);
            if (!response.ok())
                continue;

            try
            {
                auto events = json::parse(response.body);
                if (!events.is_array() || events.empty())
                    continue;

                auto &event = events[0];
                if (!event.contains("markets") || event["markets"].empty())
                    continue;

                auto &mkt = event["markets"][0];

                // Parse token IDs
                std::string token_ids_str = mkt.value("clobTokenIds", "");
                if (token_ids_str.empty())
                    continue;

                auto token_ids = json::parse(token_ids_str);
                if (!token_ids.is_array() || token_ids.size() < 2)
                    continue;

                std::string yes_token = token_ids[0].get<std::string>();
                std::string no_token = token_ids[1].get<std::string>();

                uint64_t expiry_ts = ts + 900; // 15 min after start

                // Check neg_risk
                bool neg_risk = false;
                auto neg_risk_response = clob_http.get("/neg-risk?token_id=" + yes_token);
                if (neg_risk_response.ok())
                {
                    auto nr = json::parse(neg_risk_response.body);
                    neg_risk = nr.value("neg_risk", false);
                }

                MarketState state;
                state.slug = mkt.value("slug", slug);
                state.symbol = ticker;
                state.title = mkt.value("question", ticker + " 15m");
                state.token_yes = yes_token;
                state.token_no = no_token;
                state.condition_id = mkt.value("conditionId", "");
                state.neg_risk = neg_risk;
                state.expiry_ts = expiry_ts;

                g_markets[state.slug] = state;
                g_token_to_slug[yes_token] = state.slug;
                g_token_to_slug[no_token] = state.slug;
                g_token_to_side[yes_token] = "yes";
                g_token_to_side[no_token] = "no";
                g_all_tokens.insert(yes_token);
                g_all_tokens.insert(no_token);

                new_markets++;
            }
            catch (...)
            {
                // Handle any exceptions
            }
        }
    }

    if (new_markets > 0)
    {
        std::cout << "    Added " << new_markets << " new markets (total: " << g_markets.size() << ")\n";
    }
}

void print_dashboard(const Config &cfg, int64_t elapsed_ms, bool connected)
{
    std::lock_guard<std::mutex> lock(g_mutex);

    // Count active positions
    int active_positions = 0;
    int profitable_count = 0;
    double total_unrealized_pnl = 0;
    double total_cost = 0;

    for (const auto &[slug, m] : g_markets)
    {
        if (m.entry_count > 0 || g_fills[slug].yes_shares > 0 || g_fills[slug].no_shares > 0)
        {
            active_positions++;

            const auto &fills = g_fills[slug];
            double min_shares = std::min(fills.yes_shares, fills.no_shares);
            if (min_shares > 0)
            {
                double avg_yes = fills.yes_cost / fills.yes_shares;
                double avg_no = fills.no_cost / fills.no_shares;
                double cost_per_pair = avg_yes + avg_no;
                double total_cost_pairs = min_shares * cost_per_pair;
                double gross_payout = min_shares;
                double fee_on_profit = min_shares * FEE * (1.0 - std::max(avg_yes, avg_no));
                double profit = gross_payout - fee_on_profit - total_cost_pairs;

                total_unrealized_pnl += profit;
                total_cost += total_cost_pairs;

                if (profit > 0)
                    profitable_count++;
            }
        }
    }

    // Clear and print minimalistic dashboard
    std::cout << "\033[2J\033[H"; // Clear screen

    std::cout << "=== C++ Ladder Accumulation ===\n\n";

    std::cout << "Session: " << format_duration(elapsed_ms);
    std::cout << " | Status: " << (connected ? "Connected" : "Disconnected");
    std::cout << " | Mode: " << (cfg.dry_run ? "DRY-RUN" : "LIVE") << "\n";

    std::cout << "Markets: " << g_markets.size();
    std::cout << " | Active: " << active_positions;
    std::cout << " | Profitable: " << profitable_count << "\n";

    std::cout << "Unrealized PnL: " << format_usd(total_unrealized_pnl, true);
    std::cout << " | Cost: " << format_usd(total_cost);
    if (total_cost > 0)
    {
        double roi = (total_unrealized_pnl / total_cost) * 100;
        std::cout << " | ROI: " << std::fixed << std::setprecision(2) << roi << "%";
    }
    std::cout << "\n";

    std::cout << "Orders: " << g_total_orders << " | Spent: " << format_usd(g_total_spent) << "\n";
    std::cout << "\nPress Ctrl+C to stop\n";

    // Show top positions if any
    std::vector<std::pair<std::string, double>> positions;
    for (const auto &[slug, m] : g_markets)
    {
        const auto &fills = g_fills[slug];
        if (fills.yes_shares > 0 || fills.no_shares > 0)
        {
            double min_shares = std::min(fills.yes_shares, fills.no_shares);
            double profit = 0;
            if (min_shares > 0)
            {
                double avg_yes = fills.yes_cost / fills.yes_shares;
                double avg_no = fills.no_cost / fills.no_shares;
                double cost_per_pair = avg_yes + avg_no;
                double total_cost_pairs = min_shares * cost_per_pair;
                double gross_payout = min_shares;
                double fee_on_profit = min_shares * FEE * (1.0 - std::max(avg_yes, avg_no));
                profit = gross_payout - fee_on_profit - total_cost_pairs;
            }
            positions.push_back({slug, profit});
        }
    }

    if (!positions.empty())
    {
        std::sort(positions.begin(), positions.end(),
                  [](const auto &a, const auto &b)
                  { return a.second > b.second; });

        std::cout << "\nPositions:\n";
        for (size_t i = 0; i < std::min(positions.size(), size_t(5)); i++)
        {
            const auto &[slug, profit] = positions[i];
            const auto &fills = g_fills[slug];
            std::cout << "  " << (profit > 0 ? "+" : "-") << " " << slug.substr(0, 35);
            std::cout << " Y:$" << std::fixed << std::setprecision(2) << fills.yes_cost;
            std::cout << " N:$" << fills.no_cost;
            std::cout << " PnL:" << format_usd(profit, true) << "\n";
        }
    }
}

int main(int argc, char *argv[])
{
    Config cfg;

    // Parse environment
    const char *private_key_env = std::getenv("PRIVATE_KEY");
    const char *funder_address_env = std::getenv("FUNDER_ADDRESS");

    if (!private_key_env)
    {
        std::cerr << "Error: PRIVATE_KEY environment variable required\n";
        return 1;
    }

    std::string private_key = private_key_env;
    std::string funder_address = funder_address_env ? funder_address_env : "";

    // Parse config from env
    if (auto v = std::getenv("BASE_SIZE_USDC"))
        cfg.base_size_usdc = std::stod(v);
    if (auto v = std::getenv("SIZE_MULTIPLIER"))
        cfg.size_multiplier = std::stod(v);
    if (auto v = std::getenv("PER_SYMBOL_BUDGET_USDC"))
        cfg.per_symbol_budget_usdc = std::stod(v);
    if (auto v = std::getenv("MAX_INITIAL_COMBINED"))
        cfg.max_initial_combined = std::stod(v);
    if (auto v = std::getenv("LADDER_STEP"))
        cfg.ladder_step = std::stod(v);
    if (auto v = std::getenv("MIN_USD_PER_LEG"))
        cfg.min_usd_per_leg = std::stod(v);
    if (auto v = std::getenv("DRY_RUN"))
        cfg.dry_run = (std::string(v) != "false");

    // Parse args
    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "--live")
            cfg.dry_run = false;
        if (arg == "--dry-run")
            cfg.dry_run = true;
    }

    std::cout << "╔════════════════════════════════════════════════════════════════════════════╗\n";
    std::cout << "║                    C++ Ladder Accumulation Strategy                        ║\n";
    std::cout << "╚════════════════════════════════════════════════════════════════════════════╝\n\n";

    std::cout << "Config:\n";
    std::cout << "  Mode: " << (cfg.dry_run ? "DRY-RUN" : "LIVE") << "\n";
    std::cout << "  Base size: $" << cfg.base_size_usdc << "\n";
    std::cout << "  Max initial combined: " << cfg.max_initial_combined << "\n";
    std::cout << "  Ladder step: " << cfg.ladder_step << "\n";
    std::cout << "  Min USD/leg: $" << cfg.min_usd_per_leg << "\n";
    std::cout << "  Per-symbol budget: $" << cfg.per_symbol_budget_usdc << "\n\n";

    OrderSigner signer(private_key);
    if (funder_address.empty())
        funder_address = signer.address();

    std::cout << "[1] Signer: " << signer.address() << "\n";
    std::cout << "    Funder: " << funder_address << "\n\n";

    http_global_init();

    HttpClient clob_http;
    clob_http.set_base_url(CLOB_API);
    clob_http.set_timeout_ms(10000);

    HttpClient gamma_http;
    gamma_http.set_base_url(GAMMA_API);
    gamma_http.set_timeout_ms(10000);

    // Derive API credentials
    std::cout << "[2] Deriving API credentials...\n";
    ApiCredentials creds;
    try
    {
        creds = signer.create_or_derive_api_credentials(clob_http, funder_address);
        std::cout << "    API key: " << creds.api_key.substr(0, 8) << "...\n\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "    Failed: " << e.what() << "\n";
        http_global_cleanup();
        return 1;
    }

    // Fetch initial markets
    std::cout << "[3] Fetching crypto 15m markets...\n";
    fetch_crypto_15m_markets(gamma_http, clob_http);
    std::cout << "    Found " << g_markets.size() << " markets, " << g_all_tokens.size() << " tokens\n\n";

    if (g_markets.empty())
    {
        std::cerr << "No markets found\n";
        http_global_cleanup();
        return 1;
    }

    // Setup signal handler
    std::signal(SIGINT, signal_handler);

    // WebSocket connection
    std::cout << "[4] Connecting to WebSocket...\n";
    std::atomic<bool> ws_connected{false};

    WebSocketClient ws;
    ws.set_url(WS_URL);
    ws.set_auto_reconnect(true);

    ws.on_message([&](const std::string &msg)
                  {
        try {
            auto j = json::parse(msg);
            
            // Handle orderbook updates (event_type: book)
            if (j.contains("event_type") && j["event_type"] == "book") {
                std::string asset_id = j.value("asset_id", "");
                if (asset_id.empty()) return;
                
                auto slug_it = g_token_to_slug.find(asset_id);
                if (slug_it == g_token_to_slug.end()) return;
                
                if (j.contains("asks") && !j["asks"].empty()) {
                    // Find best (lowest) ask
                    double best_ask = 1.0;
                    for (const auto& ask : j["asks"]) {
                        double price = std::stod(ask["price"].get<std::string>());
                        if (price < best_ask) best_ask = price;
                    }
                    
                    auto& market = g_markets[slug_it->second];
                    if (g_token_to_side[asset_id] == "yes") {
                        market.best_ask_yes = best_ask;
                    } else {
                        market.best_ask_no = best_ask;
                    }
                    
                    // Try entry on price update
                    try_entry(market, cfg, signer, clob_http, creds, funder_address);
                }
            }
            
            // Also handle price_change events
            if (j.contains("event_type") && j["event_type"] == "price_change") {
                std::string asset_id = j.value("asset_id", "");
                if (asset_id.empty()) return;
                
                auto slug_it = g_token_to_slug.find(asset_id);
                if (slug_it == g_token_to_slug.end()) return;
                
                if (j.contains("price")) {
                    double price = std::stod(j["price"].get<std::string>());
                    auto& market = g_markets[slug_it->second];
                    if (g_token_to_side[asset_id] == "yes") {
                        market.best_ask_yes = price;
                    } else {
                        market.best_ask_no = price;
                    }
                    try_entry(market, cfg, signer, clob_http, creds, funder_address);
                }
            }
        } catch (...) {} });

    ws.on_connect([&]()
                  {
        ws_connected = true;
        std::cout << "    WebSocket connected!\n";
        
        // Subscribe to all tokens (same format as arb_test)
        std::vector<std::string> tokens(g_all_tokens.begin(), g_all_tokens.end());
        
        json sub_msg;
        sub_msg["type"] = "subscribe";
        sub_msg["channel"] = "market";
        sub_msg["assets_ids"] = tokens;
        ws.send(sub_msg.dump());
        
        std::cout << "    Subscribed to " << tokens.size() << " tokens\n\n"; });

    ws.on_disconnect([&]()
                     { ws_connected = false; });

    // Connect in background thread
    std::thread ws_thread([&]()
                          {
        ws.connect();
        ws.run(); });

    // Wait for connection
    for (int i = 0; i < 50 && !ws_connected.load(); i++)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (!ws_connected.load())
    {
        std::cerr << "Failed to connect to WebSocket\n";
        g_running = false;
    }

    auto start_time = std::chrono::steady_clock::now();
    auto last_refresh = start_time;
    auto last_dashboard = start_time;

    std::cout << "[5] Running ladder accumulation...\n\n";

    while (g_running)
    {
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - start_time).count();

        // Refresh markets every 30 seconds
        auto since_refresh = std::chrono::duration_cast<std::chrono::seconds>(now - last_refresh).count();
        if (since_refresh >= 30)
        {
            fetch_crypto_15m_markets(gamma_http, clob_http);
            last_refresh = now;
        }

        // Update dashboard every 5 seconds
        auto since_dashboard = std::chrono::duration_cast<std::chrono::seconds>(now - last_dashboard).count();
        if (since_dashboard >= 5)
        {
            print_dashboard(cfg, elapsed, ws_connected.load());
            last_dashboard = now;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Cleanup
    std::cout << "\n\nShutting down...\n";
    ws.stop();
    if (ws_thread.joinable())
        ws_thread.join();

    // Print final summary
    print_dashboard(cfg,
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - start_time)
                        .count(),
                    false);

    http_global_cleanup();
    return 0;
}
