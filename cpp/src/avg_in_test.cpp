/**
 * Average-In Strategy Test
 *
 * Strategy:
 * 1. Enter based on current prices (not 50/50 - markets already traded)
 * 2. Over the 15 minutes, ladder buy both YES and NO to average down
 * 3. Track live PnL: if one side is cheap enough, can exit early by selling other side
 * 4. Goal: combined average cost < 1.00 OR early exit when profitable
 * 5. At expiry, one side pays $1/share, profit = min_shares - total_cost
 *
 * No low-latency required - we have 15 minutes to accumulate.
 *
 * Build: cmake --build build --target avg_in_test
 * Run: PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/avg_in_test
 */

#include <order_signer.hpp>
#include <http_client.hpp>
#include <websocket_client.hpp>
#include <nlohmann/json.hpp>
#include <iostream>
#include <cstdlib>
#include <chrono>
#include <iomanip>
#include <thread>
#include <atomic>
#include <mutex>
#include <cmath>
#include <csignal>

using json = nlohmann::json;
using namespace polymarket;

const std::string CLOB_API = "https://clob.polymarket.com";
const std::string GAMMA_API = "https://gamma-api.polymarket.com";
const std::string WS_URL = "wss://ws-live-data.polymarket.com";
const std::string NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const std::string CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

std::atomic<bool> g_running{true};

struct Position
{
    double shares = 0;
    double cost = 0;
    double avg_price() const { return shares > 0 ? cost / shares : 0; }
    double value_at(double price) const { return shares * price; }
};

struct MarketState
{
    std::string slug;
    std::string token_yes;
    std::string token_no;
    bool neg_risk = false;
    uint64_t expiry_ts = 0;
    uint64_t start_ts = 0;

    // Real-time prices
    double best_ask_yes = 0.99;
    double best_ask_no = 0.99;

    // Positions
    Position yes_pos;
    Position no_pos;

    // Entry tracking
    bool initial_entry_done = false;
    int total_entries = 0;
    double last_yes_entry_price = 0;
    double last_no_entry_price = 0;

    double combined_avg() const
    {
        if (yes_pos.shares == 0 || no_pos.shares == 0)
            return 2.0;
        return yes_pos.avg_price() + no_pos.avg_price();
    }

    double min_shares() const { return std::min(yes_pos.shares, no_pos.shares); }
    double total_cost() const { return yes_pos.cost + no_pos.cost; }

    double projected_profit() const
    {
        double ms = min_shares();
        if (ms <= 0)
            return 0;
        // Payout is $1 per share for winning side
        // Cost is total spent on both sides for min_shares pairs
        double cost_per_pair = yes_pos.avg_price() + no_pos.avg_price();
        return ms * (1.0 - cost_per_pair);
    }

    bool is_profitable() const { return combined_avg() < 1.0; }

    // Live PnL if we sold positions now at current bid prices
    // (For simplicity, use ask - 0.01 as estimated bid)
    double live_pnl(double yes_bid, double no_bid) const
    {
        double yes_value = yes_pos.shares * yes_bid;
        double no_value = no_pos.shares * no_bid;
        return (yes_value + no_value) - total_cost();
    }

    // Check if we can exit profitably by selling one side
    // Returns: "yes" to sell YES, "no" to sell NO, "" to hold
    std::string should_early_exit(double yes_bid, double no_bid, double min_profit = 0.05) const
    {
        if (yes_pos.shares == 0 || no_pos.shares == 0)
            return "";

        // If combined avg < 1, hold to expiry (guaranteed profit)
        if (combined_avg() < 1.0)
            return "";

        // Strategy: Sell one side now, hold the other to expiry
        // We don't know which side wins, so we need the sell to lock in enough
        // profit to cover potential loss on the held side.
        //
        // Scenario A: Sell YES now, hold NO to expiry
        //   If NO wins: profit = YES_sell_value + NO_shares*1 - total_cost
        //   If NO loses: profit = YES_sell_value + 0 - total_cost
        //   Worst case (NO loses): YES_sell_value - total_cost
        //
        // Only exit if worst case is profitable
        double yes_sell_value = yes_bid * yes_pos.shares;
        double worst_case_sell_yes = yes_sell_value - total_cost();
        if (worst_case_sell_yes > min_profit)
        {
            return "yes";
        }

        double no_sell_value = no_bid * no_pos.shares;
        double worst_case_sell_no = no_sell_value - total_cost();
        if (worst_case_sell_no > min_profit)
        {
            return "no";
        }

        return "";
    }
};

struct Config
{
    double initial_size_usdc = 2.0;      // Initial entry per side
    double avg_size_usdc = 1.0;          // Size for averaging entries
    double min_improvement = 0.02;       // Min price drop to avg in (2 cents)
    double target_combined = 0.98;       // Target combined avg
    double max_imbalance = 0.3;          // Max cost imbalance ratio before rebalancing
    int max_entries_per_side = 10;       // Max averaging entries per side
    double early_exit_min_profit = 0.05; // Min profit to trigger early exit ($)
    bool dry_run = true;
};

void signal_handler(int) { g_running = false; }

std::string format_price(double p)
{
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(2) << p;
    return oss.str();
}

std::string format_usd(double v)
{
    std::ostringstream oss;
    oss << "$" << std::fixed << std::setprecision(2) << v;
    return oss.str();
}

bool place_order(const std::string &side, double price, double amount_usd,
                 MarketState &market, OrderSigner &signer, HttpClient &http,
                 const ApiCredentials &creds, const std::string &funder_address,
                 const Config &cfg)
{
    double shares = amount_usd / price;
    std::string token_id = (side == "yes") ? market.token_yes : market.token_no;
    std::string exchange_addr = market.neg_risk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

    std::cout << "    ORDER: " << side << " " << std::fixed << std::setprecision(2)
              << shares << " shares @ " << price << " = " << format_usd(amount_usd) << "\n";

    if (cfg.dry_run)
    {
        std::cout << "    [DRY RUN] Would place order\n";
        // Simulate fill
        if (side == "yes")
        {
            market.yes_pos.shares += shares;
            market.yes_pos.cost += amount_usd;
            market.last_yes_entry_price = price;
        }
        else
        {
            market.no_pos.shares += shares;
            market.no_pos.cost += amount_usd;
            market.last_no_entry_price = price;
        }
        market.total_entries++;
        return true;
    }

    // Create and sign order
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
            std::cout << "    ✅ FILLED\n";
            if (side == "yes")
            {
                market.yes_pos.shares += shares;
                market.yes_pos.cost += amount_usd;
                market.last_yes_entry_price = price;
            }
            else
            {
                market.no_pos.shares += shares;
                market.no_pos.cost += amount_usd;
                market.last_no_entry_price = price;
            }
            market.total_entries++;
            return true;
        }
        else
        {
            std::cout << "    ⚠️ " << status << ": " << result.value("errorMsg", "") << "\n";
            return false;
        }
    }
    else
    {
        std::cout << "    ❌ HTTP " << response.status_code << ": " << response.body.substr(0, 100) << "\n";
        return false;
    }
}

void try_averaging(MarketState &market, OrderSigner &signer, HttpClient &http,
                   const ApiCredentials &creds, const std::string &funder_address,
                   const Config &cfg)
{
    if (!market.initial_entry_done)
        return;

    // Check if we should average into YES
    bool should_avg_yes = false;
    if (market.yes_pos.shares > 0 && market.total_entries < cfg.max_entries_per_side * 2)
    {
        double improvement = market.last_yes_entry_price - market.best_ask_yes;
        if (improvement >= cfg.min_improvement)
        {
            should_avg_yes = true;
        }
    }

    // Check if we should average into NO
    bool should_avg_no = false;
    if (market.no_pos.shares > 0 && market.total_entries < cfg.max_entries_per_side * 2)
    {
        double improvement = market.last_no_entry_price - market.best_ask_no;
        if (improvement >= cfg.min_improvement)
        {
            should_avg_no = true;
        }
    }

    // Check imbalance - if one side has much more cost, prioritize the other
    double yes_cost = market.yes_pos.cost;
    double no_cost = market.no_pos.cost;
    double total = yes_cost + no_cost;
    if (total > 0)
    {
        double imbalance = std::abs(yes_cost - no_cost) / total;
        if (imbalance > cfg.max_imbalance)
        {
            // Prioritize the smaller side
            if (yes_cost < no_cost)
            {
                should_avg_yes = true;
                should_avg_no = false;
            }
            else
            {
                should_avg_no = true;
                should_avg_yes = false;
            }
        }
    }

    // Execute averaging
    if (should_avg_yes)
    {
        std::cout << "\n  [AVG] Averaging into YES (price dropped " << format_price(market.last_yes_entry_price - market.best_ask_yes) << ")\n";
        place_order("yes", market.best_ask_yes + 0.01, cfg.avg_size_usdc,
                    market, signer, http, creds, funder_address, cfg);
    }

    if (should_avg_no)
    {
        std::cout << "\n  [AVG] Averaging into NO (price dropped " << format_price(market.last_no_entry_price - market.best_ask_no) << ")\n";
        place_order("no", market.best_ask_no + 0.01, cfg.avg_size_usdc,
                    market, signer, http, creds, funder_address, cfg);
    }
}

void print_status(const MarketState &market, uint64_t now)
{
    int64_t time_left = static_cast<int64_t>(market.expiry_ts) - static_cast<int64_t>(now);
    int mins = time_left / 60;
    int secs = time_left % 60;

    std::cout << "\r  [" << mins << ":" << std::setfill('0') << std::setw(2) << secs << std::setfill(' ') << "] ";
    std::cout << "YES: " << format_price(market.best_ask_yes) << " (" << format_usd(market.yes_pos.cost) << ")";
    std::cout << " | NO: " << format_price(market.best_ask_no) << " (" << format_usd(market.no_pos.cost) << ")";
    std::cout << " | Combined: " << format_price(market.best_ask_yes + market.best_ask_no);
    if (market.yes_pos.shares > 0 && market.no_pos.shares > 0)
    {
        std::cout << " | Avg: " << format_price(market.combined_avg());
        std::cout << " | PnL: " << format_usd(market.projected_profit());
    }
    std::cout << "          " << std::flush;
}

int main(int argc, char *argv[])
{
    Config cfg;

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
    if (auto v = std::getenv("INITIAL_SIZE_USDC"))
        cfg.initial_size_usdc = std::stod(v);
    if (auto v = std::getenv("AVG_SIZE_USDC"))
        cfg.avg_size_usdc = std::stod(v);
    if (auto v = std::getenv("MIN_IMPROVEMENT"))
        cfg.min_improvement = std::stod(v);
    if (auto v = std::getenv("TARGET_COMBINED"))
        cfg.target_combined = std::stod(v);
    if (auto v = std::getenv("DRY_RUN"))
        cfg.dry_run = (std::string(v) != "false");

    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "--live")
            cfg.dry_run = false;
        if (arg == "--dry-run")
            cfg.dry_run = true;
    }

    std::cout << "=== Average-In Strategy Test ===\n\n";
    std::cout << "Config:\n";
    std::cout << "  Mode: " << (cfg.dry_run ? "DRY-RUN" : "LIVE") << "\n";
    std::cout << "  Initial size: " << format_usd(cfg.initial_size_usdc) << " per side\n";
    std::cout << "  Avg size: " << format_usd(cfg.avg_size_usdc) << "\n";
    std::cout << "  Min improvement: " << format_price(cfg.min_improvement) << "\n";
    std::cout << "  Target combined: " << format_price(cfg.target_combined) << "\n\n";

    OrderSigner signer(private_key);
    if (funder_address.empty())
        funder_address = signer.address();

    std::cout << "Signer: " << signer.address() << "\n";
    std::cout << "Funder: " << funder_address << "\n\n";

    http_global_init();

    HttpClient http;
    http.set_base_url(CLOB_API);
    http.set_timeout_ms(10000);

    // Derive API credentials
    std::cout << "[1] Deriving API credentials...\n";
    ApiCredentials creds;
    try
    {
        creds = signer.create_or_derive_api_credentials(http, funder_address);
        std::cout << "    API key: " << creds.api_key.substr(0, 8) << "...\n\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "    Failed: " << e.what() << "\n";
        http_global_cleanup();
        return 1;
    }

    std::signal(SIGINT, signal_handler);

    // Main loop - find markets and trade
    while (g_running)
    {
        // Find next ETH 15m market
        std::cout << "[2] Finding ETH 15m market...\n";

        MarketState market;
        uint64_t now_ts = static_cast<uint64_t>(std::time(nullptr));
        uint64_t interval = 15 * 60;
        uint64_t current_window = (now_ts / interval) * interval;

        // Look for market starting soon or just started
        for (int i = 0; i <= 2 && market.token_yes.empty(); i++)
        {
            uint64_t start_ts = current_window + i * interval;
            uint64_t expiry_ts = start_ts + interval;

            // Skip if less than 2 min left
            if (expiry_ts < now_ts + 120)
                continue;

            std::string slug = "eth-updown-15m-" + std::to_string(start_ts);

            HttpClient gamma_http;
            gamma_http.set_base_url(GAMMA_API);
            gamma_http.set_timeout_ms(10000);

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
                auto token_ids = json::parse(mkt["clobTokenIds"].get<std::string>());

                market.slug = slug;
                market.token_yes = token_ids[0].get<std::string>();
                market.token_no = token_ids[1].get<std::string>();
                market.start_ts = start_ts;
                market.expiry_ts = expiry_ts;

                // Check neg_risk
                auto neg_risk_response = http.get("/neg-risk?token_id=" + market.token_yes);
                if (neg_risk_response.ok())
                {
                    auto nr = json::parse(neg_risk_response.body);
                    market.neg_risk = nr.value("neg_risk", false);
                }

                int64_t time_left = static_cast<int64_t>(expiry_ts) - static_cast<int64_t>(now_ts);
                std::cout << "    Found: " << slug << " (expires in " << time_left / 60 << "min)\n";
            }
            catch (...)
            {
                continue;
            }
        }

        if (market.token_yes.empty())
        {
            std::cout << "    No suitable market found, waiting 30s...\n";
            std::this_thread::sleep_for(std::chrono::seconds(30));
            continue;
        }

        // Get initial orderbook
        auto yes_book = http.get("/book?token_id=" + market.token_yes);
        auto no_book = http.get("/book?token_id=" + market.token_no);

        if (yes_book.ok() && no_book.ok())
        {
            auto yes_json = json::parse(yes_book.body);
            auto no_json = json::parse(no_book.body);

            if (yes_json.contains("asks") && !yes_json["asks"].empty())
            {
                double best = 1.0;
                for (const auto &ask : yes_json["asks"])
                {
                    double price = std::stod(ask["price"].get<std::string>());
                    if (price < best)
                        best = price;
                }
                market.best_ask_yes = best;
            }

            if (no_json.contains("asks") && !no_json["asks"].empty())
            {
                double best = 1.0;
                for (const auto &ask : no_json["asks"])
                {
                    double price = std::stod(ask["price"].get<std::string>());
                    if (price < best)
                        best = price;
                }
                market.best_ask_no = best;
            }
        }

        std::cout << "    YES ask: " << format_price(market.best_ask_yes) << "\n";
        std::cout << "    NO ask:  " << format_price(market.best_ask_no) << "\n";
        std::cout << "    Combined: " << format_price(market.best_ask_yes + market.best_ask_no) << "\n\n";

        // Connect WebSocket for real-time prices
        std::cout << "[3] Connecting to WebSocket...\n";
        std::atomic<bool> ws_connected{false};
        std::mutex price_mutex;

        WebSocketClient ws;
        ws.set_url(WS_URL);
        ws.set_auto_reconnect(true);

        ws.on_connect([&]()
                      {
            ws_connected = true;
            std::cout << "    WebSocket connected!\n";
            
            json token_array = json::array({market.token_yes, market.token_no});
            json subscribe_msg;
            subscribe_msg["action"] = "subscribe";
            subscribe_msg["subscriptions"] = json::array({
                {{"topic", "clob_market"}, {"type", "agg_orderbook"}, {"filters", token_array.dump()}}
            });
            ws.send(subscribe_msg.dump()); });

        ws.on_message([&](const std::string &msg)
                      {
            try {
                auto j = json::parse(msg);
                if (!j.contains("payload")) return;
                auto payload = j["payload"];
                
                // Handle array (initial snapshot)
                if (payload.is_array()) {
                    for (const auto& book : payload) {
                        std::string asset_id = book.value("asset_id", "");
                        if (book.contains("asks") && !book["asks"].empty()) {
                            double best = 1.0;
                            for (const auto& ask : book["asks"]) {
                                double price = std::stod(ask["price"].get<std::string>());
                                if (price < best) best = price;
                            }
                            std::lock_guard<std::mutex> lock(price_mutex);
                            if (asset_id == market.token_yes) market.best_ask_yes = best;
                            else if (asset_id == market.token_no) market.best_ask_no = best;
                        }
                    }
                }
                // Handle single update
                else if (payload.is_object()) {
                    std::string asset_id = payload.value("asset_id", "");
                    if (payload.contains("asks") && !payload["asks"].empty()) {
                        double best = 1.0;
                        for (const auto& ask : payload["asks"]) {
                            double price = std::stod(ask["price"].get<std::string>());
                            if (price < best) best = price;
                        }
                        std::lock_guard<std::mutex> lock(price_mutex);
                        if (asset_id == market.token_yes) market.best_ask_yes = best;
                        else if (asset_id == market.token_no) market.best_ask_no = best;
                    }
                }
            } catch (...) {} });

        std::thread ws_thread([&]()
                              {
            ws.connect();
            ws.run(); });

        // Wait for connection
        for (int i = 0; i < 50 && !ws_connected.load(); i++)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Place initial entry based on current prices (not 50/50)
        std::cout << "\n[4] Placing initial entry...\n";
        {
            double yes_price = market.best_ask_yes + 0.01; // 1 cent slippage
            double no_price = market.best_ask_no + 0.01;
            double combined = yes_price + no_price;

            // Determine initial allocation based on prices
            // If combined > 1.02, start with smaller side (cheaper)
            // If combined <= 1.02, go 50/50
            double yes_size = cfg.initial_size_usdc;
            double no_size = cfg.initial_size_usdc;

            if (combined > 1.02)
            {
                // Start with the cheaper side, smaller on expensive side
                if (yes_price < no_price)
                {
                    yes_size = cfg.initial_size_usdc;
                    no_size = cfg.initial_size_usdc * 0.5;
                }
                else
                {
                    no_size = cfg.initial_size_usdc;
                    yes_size = cfg.initial_size_usdc * 0.5;
                }
                std::cout << "  Combined " << format_price(combined) << " > 1.02, asymmetric entry\n";
            }
            else
            {
                std::cout << "  Combined " << format_price(combined) << " <= 1.02, 50/50 entry\n";
            }

            std::cout << "  [INITIAL] Opening YES position (" << format_usd(yes_size) << ")\n";
            place_order("yes", yes_price, yes_size,
                        market, signer, http, creds, funder_address, cfg);

            std::cout << "  [INITIAL] Opening NO position (" << format_usd(no_size) << ")\n";
            place_order("no", no_price, no_size,
                        market, signer, http, creds, funder_address, cfg);

            market.initial_entry_done = true;
        }

        std::cout << "\n[5] Monitoring and averaging...\n";
        std::cout << "    Press Ctrl+C to exit\n\n";

        auto last_avg_check = std::chrono::steady_clock::now();
        auto last_status = std::chrono::steady_clock::now();

        // Monitor until market expires
        while (g_running)
        {
            uint64_t now = static_cast<uint64_t>(std::time(nullptr));

            // Check if market expired
            if (now >= market.expiry_ts)
            {
                std::cout << "\n\n    Market expired!\n";
                break;
            }

            // Print status every 5 seconds
            auto now_clock = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now_clock - last_status).count() >= 5)
            {
                print_status(market, now);
                last_status = now_clock;
            }

            // Check for averaging opportunities every 10 seconds
            if (std::chrono::duration_cast<std::chrono::seconds>(now_clock - last_avg_check).count() >= 10)
            {
                try_averaging(market, signer, http, creds, funder_address, cfg);

                // Check for early exit opportunity (only if combined avg >= 1)
                double yes_bid = market.best_ask_yes - 0.01; // Estimate bid
                double no_bid = market.best_ask_no - 0.01;
                std::string exit_side = market.should_early_exit(yes_bid, no_bid, cfg.early_exit_min_profit);

                if (!exit_side.empty())
                {
                    std::cout << "\n\n  [EARLY EXIT] Selling " << exit_side << " side for profit!\n";
                    double sell_price = (exit_side == "yes") ? yes_bid : no_bid;
                    double sell_shares = (exit_side == "yes") ? market.yes_pos.shares : market.no_pos.shares;

                    // TODO: Implement sell order
                    std::cout << "    Would sell " << std::fixed << std::setprecision(2) << sell_shares
                              << " " << exit_side << " shares @ " << format_price(sell_price) << "\n";

                    if (!cfg.dry_run)
                    {
                        // Place sell order here
                        // For now, just log
                    }
                }

                last_avg_check = now_clock;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Print final results
        std::cout << "\n\n=== Final Results ===\n";
        std::cout << "  YES: " << std::fixed << std::setprecision(2) << market.yes_pos.shares
                  << " shares @ avg " << format_price(market.yes_pos.avg_price())
                  << " = " << format_usd(market.yes_pos.cost) << "\n";
        std::cout << "  NO:  " << market.no_pos.shares
                  << " shares @ avg " << format_price(market.no_pos.avg_price())
                  << " = " << format_usd(market.no_pos.cost) << "\n";
        std::cout << "  Combined avg: " << format_price(market.combined_avg()) << "\n";
        std::cout << "  Min shares (pairs): " << market.min_shares() << "\n";
        std::cout << "  Total cost: " << format_usd(market.total_cost()) << "\n";
        std::cout << "  Projected profit: " << format_usd(market.projected_profit());
        if (market.is_profitable())
            std::cout << " ✅";
        else
            std::cout << " ❌";
        std::cout << "\n";
        std::cout << "  Total entries: " << market.total_entries << "\n";

        // Cleanup WebSocket
        ws.stop();
        if (ws_thread.joinable())
            ws_thread.join();

        if (!g_running)
            break;

        std::cout << "\n    Waiting for next market...\n\n";
        std::this_thread::sleep_for(std::chrono::seconds(10));
    }

    http_global_cleanup();
    std::cout << "\nDone.\n";
    return 0;
}
