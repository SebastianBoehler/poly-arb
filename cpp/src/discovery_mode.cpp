#include <discovery_options.hpp>
#include <example_strategies.hpp>
#include <market_fetcher.hpp>
#include <slippage.hpp>
#include <types.hpp>

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <csignal>
#include <string>
#include <thread>
#include <vector>

namespace
{
std::atomic<bool> g_running{true};

struct SnapshotResult
{
    polyarb::MarketSnapshot snapshot;
    std::vector<polymarket::PriceLevel> yes_asks;
    std::vector<polymarket::PriceLevel> no_asks;
};

void signal_handler(int)
{
    g_running.store(false);
}

std::vector<polymarket::MarketState> fetch_markets(
    polymarket::MarketFetcher &fetcher,
    const polyarb::DiscoveryOptions &options)
{
    if (options.crypto_15m)
    {
        auto markets = fetcher.fetch_crypto_15m_markets();
        if (markets.size() > static_cast<size_t>(options.max_markets))
        {
            markets.resize(static_cast<size_t>(options.max_markets));
        }
        return markets;
    }

    std::vector<polymarket::MarketState> markets;
    for (const auto &market : fetcher.fetch_neg_risk_markets(options.max_markets))
    {
        markets.push_back(polymarket::MarketFetcher::to_market_state(market));
    }
    return markets;
}

SnapshotResult snapshot_market(
    polymarket::MarketFetcher &fetcher,
    const polymarket::MarketState &market)
{
    SnapshotResult result;
    auto &snapshot = result.snapshot;

    snapshot.slug = market.slug;
    snapshot.title = market.title;
    snapshot.condition_id = market.condition_id;
    snapshot.token_yes = market.token_yes;
    snapshot.token_no = market.token_no;
    snapshot.timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                std::chrono::system_clock::now().time_since_epoch())
                                .count();
    const auto yes_book = fetcher.fetch_orderbook(market.token_yes);
    const auto no_book = fetcher.fetch_orderbook(market.token_no);

    if (yes_book)
    {
        snapshot.yes_bid = yes_book->best_bid();
        snapshot.yes_ask = yes_book->best_ask();
        snapshot.yes_ask_size = yes_book->best_ask_size();
        result.yes_asks = yes_book->asks;
    }
    if (no_book)
    {
        snapshot.no_bid = no_book->best_bid();
        snapshot.no_ask = no_book->best_ask();
        snapshot.no_ask_size = no_book->best_ask_size();
        result.no_asks = no_book->asks;
    }
    return result;
}

nlohmann::json fill_to_json(const polyarb::FillSimulation &fill)
{
    return {
        {"fillable", fill.fillable},
        {"requested_shares", fill.requested_shares},
        {"filled_shares", fill.filled_shares},
        {"unfilled_shares", fill.unfilled_shares},
        {"spent_usdc", fill.spent_usdc},
        {"avg_price", fill.avg_price},
        {"best_price", fill.best_price},
        {"slippage_bps", fill.slippage_bps},
    };
}

nlohmann::json snapshot_to_json(
    const SnapshotResult &result,
    const polyarb::StrategyConfig &strategy)
{
    const auto &snapshot = result.snapshot;
    const double combined = snapshot.yes_ask + snapshot.no_ask;
    const double top_depth = std::min(
        snapshot.yes_ask * snapshot.yes_ask_size,
        snapshot.no_ask * snapshot.no_ask_size);
    const double bundles = combined > 0.0 ? strategy.paper_stake_usdc / combined : 0.0;
    const auto sweep = polyarb::simulate_binary_bundle_buy(result.yes_asks, result.no_asks, bundles);

    return {
        {"kind", "snapshot"},
        {"timestamp_ns", snapshot.timestamp_ns},
        {"slug", snapshot.slug},
        {"title", snapshot.title},
        {"condition_id", snapshot.condition_id},
        {"token_yes", snapshot.token_yes},
        {"token_no", snapshot.token_no},
        {"yes_bid", snapshot.yes_bid},
        {"yes_ask", snapshot.yes_ask},
        {"no_bid", snapshot.no_bid},
        {"no_ask", snapshot.no_ask},
        {"yes_ask_size", snapshot.yes_ask_size},
        {"no_ask_size", snapshot.no_ask_size},
        {"combined_best_ask", combined},
        {"top_depth_usdc", top_depth},
        {"paper_bundles", bundles},
        {"sweep", {
                      {"fillable", sweep.fillable},
                      {"combined_avg_price", sweep.combined_avg_price},
                      {"combined_best_price", sweep.combined_best_price},
                      {"edge_cents", sweep.edge_cents},
                      {"yes", fill_to_json(sweep.yes)},
                      {"no", fill_to_json(sweep.no)},
                  }},
    };
}

nlohmann::json signal_to_json(const polyarb::StrategySignal &signal)
{
    nlohmann::json j = {
        {"kind", "signal"},
        {"type", polyarb::signal_type_name(signal.type)},
        {"slug", signal.slug},
        {"reason", signal.reason},
        {"score", signal.score},
        {"edge_cents", signal.edge_cents},
        {"combined_ask", signal.combined_ask},
        {"executable_depth_usdc", signal.executable_depth_usdc},
    };
    if (signal.paper_trade)
    {
        j["paper_trade"] = {
            {"stake_usdc", signal.paper_trade->stake_usdc},
            {"expected_payout_usdc", signal.paper_trade->expected_payout_usdc},
            {"expected_edge_usdc", signal.paper_trade->expected_edge_usdc},
            {"yes_shares", signal.paper_trade->yes_shares},
            {"no_shares", signal.paper_trade->no_shares},
        };
    }
    return j;
}

void write_event(std::ostream *output, const nlohmann::json &event)
{
    const std::string line = event.dump();
    std::cout << line << '\n';
    if (output)
    {
        *output << line << '\n';
    }
}
} // namespace

int main(int argc, char *argv[])
{
    std::vector<std::string> args(argv, argv + argc);
    const auto options = polyarb::parse_discovery_options(args);
    if (options.show_help)
    {
        std::cout << polyarb::discovery_usage();
        return 0;
    }

    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    polymarket::Config config;
    config.max_markets = options.max_markets;
    config.trigger_combined = options.strategy.arb_threshold;
    polymarket::http_global_init();

    std::ofstream output;
    if (!options.output_path.empty())
    {
        const std::filesystem::path output_path(options.output_path);
        if (output_path.has_parent_path())
        {
            std::filesystem::create_directories(output_path.parent_path());
        }
        output.open(options.output_path, std::ios::app);
        if (!output)
        {
            std::cerr << "Failed to open output file: " << options.output_path << '\n';
            polymarket::http_global_cleanup();
            return 1;
        }
    }

    polymarket::MarketFetcher fetcher(config);
    const auto started_at = std::chrono::steady_clock::now();
    int completed_iterations = 0;
    while (g_running.load() &&
           polyarb::should_continue_discovery(completed_iterations, started_at, options))
    {
        const auto markets = fetch_markets(fetcher, options);
        for (const auto &market : markets)
        {
            const auto result = snapshot_market(fetcher, market);
            if (!options.signals_only)
            {
                write_event(output ? &output : nullptr, snapshot_to_json(result, options.strategy));
            }

            for (const auto &signal : polyarb::evaluate_example_strategies(result.snapshot, options.strategy))
            {
                auto event = signal_to_json(signal);
                event["timestamp_ns"] = result.snapshot.timestamp_ns;
                event["title"] = result.snapshot.title;
                event["condition_id"] = result.snapshot.condition_id;
                write_event(output ? &output : nullptr, event);
            }
        }

        ++completed_iterations;
        if (g_running.load() &&
            polyarb::should_continue_discovery(completed_iterations, started_at, options))
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(options.interval_ms));
        }
    }

    polymarket::http_global_cleanup();
    return 0;
}
