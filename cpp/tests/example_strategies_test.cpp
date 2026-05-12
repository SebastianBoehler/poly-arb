#include <discovery_options.hpp>
#include <example_strategies.hpp>
#include <slippage.hpp>

#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

namespace
{
void require(bool condition, const std::string &message)
{
    if (!condition)
    {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

polyarb::MarketSnapshot make_snapshot()
{
    polyarb::MarketSnapshot snapshot;
    snapshot.slug = "btc-updown-15m-test";
    snapshot.condition_id = "0xcondition";
    snapshot.token_yes = "yes";
    snapshot.token_no = "no";
    snapshot.yes_bid = 0.44;
    snapshot.yes_ask = 0.46;
    snapshot.no_bid = 0.48;
    snapshot.no_ask = 0.49;
    snapshot.yes_ask_size = 50.0;
    snapshot.no_ask_size = 40.0;
    return snapshot;
}
} // namespace

int main()
{
    polyarb::StrategyConfig config;
    config.arb_threshold = 0.98;
    config.min_depth_usd = 10.0;
    config.min_market_making_spread_bps = 300.0;

    auto signals = polyarb::evaluate_example_strategies(make_snapshot(), config);
    require(!signals.empty(), "expected at least one signal");

    const auto *arb = polyarb::find_signal(signals, polyarb::SignalType::BinaryArbitrage);
    require(arb != nullptr, "expected binary arbitrage signal");
    require(std::abs(arb->edge_cents - 5.0) < 0.0001, "expected 5 cent edge");
    require(arb->paper_trade.has_value(), "expected paper-trade projection");
    require(std::abs(arb->paper_trade->expected_edge_usdc - 0.5) < 0.0001, "expected paper edge on $10 stake");

    auto shallow = make_snapshot();
    shallow.no_ask_size = 1.0;
    signals = polyarb::evaluate_example_strategies(shallow, config);
    require(polyarb::find_signal(signals, polyarb::SignalType::BinaryArbitrage) == nullptr,
            "expected shallow market to skip arbitrage");

    auto maker = make_snapshot();
    maker.yes_bid = 0.40;
    maker.yes_ask = 0.50;
    signals = polyarb::evaluate_example_strategies(maker, config);
    require(polyarb::find_signal(signals, polyarb::SignalType::MarketMakingCandidate) != nullptr,
            "expected market-making candidate");

    std::vector<polymarket::PriceLevel> asks = {
        {0.52, 10.0},
        {0.50, 5.0},
        {0.51, 5.0},
    };
    const auto fill = polyarb::simulate_buy_shares(asks, 8.0);
    require(fill.fillable, "expected share sweep to fill");
    require(std::abs(fill.spent_usdc - 4.03) < 0.0001, "expected weighted sweep cost");
    require(std::abs(fill.avg_price - 0.50375) < 0.0001, "expected weighted average price");
    require(std::abs(fill.slippage_bps - 75.0) < 0.0001, "expected bps slippage vs best ask");

    const auto shallow_fill = polyarb::simulate_buy_shares(asks, 25.0);
    require(!shallow_fill.fillable, "expected shallow book to be unfillable");
    require(std::abs(shallow_fill.unfilled_shares - 5.0) < 0.0001, "expected unfilled shares");

    const std::vector<polymarket::PriceLevel> yes_asks = {{0.46, 10.0}, {0.47, 10.0}};
    const std::vector<polymarket::PriceLevel> no_asks = {{0.49, 10.0}, {0.50, 10.0}};
    const auto bundle = polyarb::simulate_binary_bundle_buy(yes_asks, no_asks, 8.0);
    require(bundle.fillable, "expected bundle sweep to fill");
    require(std::abs(bundle.combined_avg_price - 0.95) < 0.0001, "expected combined average price");
    require(std::abs(bundle.edge_cents - 5.0) < 0.0001, "expected bundle edge");

    const std::vector<polymarket::PriceLevel> thin_yes = {{0.01, 1.0}};
    const std::vector<polymarket::PriceLevel> thin_no = {{0.01, 1.0}};
    const auto unfillable_bundle = polyarb::simulate_binary_bundle_buy(thin_yes, thin_no, 10.0);
    require(!unfillable_bundle.fillable, "expected thin bundle to be unfillable");
    require(unfillable_bundle.edge_cents <= 0.0, "expected unfillable bundle to avoid positive edge");

    const auto forever = polyarb::parse_discovery_options({"discovery_mode", "--15m", "--max", "18"});
    require(forever.crypto_15m, "expected 15m option");
    require(forever.max_markets == 18, "expected max market option");
    require(!forever.max_iterations.has_value(), "expected default run-until-stopped mode");
    require(!forever.max_runtime_ms.has_value(), "expected no default timeout");

    const auto timed = polyarb::parse_discovery_options({"discovery_mode", "--duration-min", "30", "--interval-ms", "5000"});
    require(timed.max_runtime_ms == 30 * 60 * 1000, "expected minute duration conversion");
    require(timed.interval_ms == 5000, "expected interval option");

    const auto bounded = polyarb::parse_discovery_options({"discovery_mode", "--iterations", "3"});
    const auto started = std::chrono::steady_clock::now();
    require(polyarb::should_continue_discovery(2, started, bounded), "expected bounded run to continue before max iterations");
    require(!polyarb::should_continue_discovery(3, started, bounded), "expected bounded run to stop at max iterations");

    return 0;
}
