#include <example_strategies.hpp>

#include <algorithm>
#include <cmath>

namespace polyarb
{
namespace
{
bool valid_price(double price)
{
    return price > 0.0 && price < 1.0;
}

double ask_depth_usdc(double price, double size)
{
    if (!valid_price(price) || size <= 0.0)
    {
        return 0.0;
    }
    return price * size;
}

double spread_bps(double bid, double ask)
{
    if (!valid_price(bid) || !valid_price(ask) || ask <= bid)
    {
        return 0.0;
    }

    const double mid = (bid + ask) / 2.0;
    return mid > 0.0 ? ((ask - bid) / mid) * 10000.0 : 0.0;
}

PaperTrade project_binary_arb(const MarketSnapshot &snapshot, double stake_usdc)
{
    PaperTrade trade;
    const double combined = snapshot.yes_ask + snapshot.no_ask;
    const double bundles = combined > 0.0 ? stake_usdc / combined : 0.0;

    trade.stake_usdc = stake_usdc;
    trade.yes_shares = bundles;
    trade.no_shares = bundles;
    trade.expected_edge_usdc = stake_usdc * (1.0 - combined);
    trade.expected_payout_usdc = stake_usdc + trade.expected_edge_usdc;
    return trade;
}
} // namespace

std::vector<StrategySignal> evaluate_example_strategies(
    const MarketSnapshot &snapshot,
    const StrategyConfig &config)
{
    std::vector<StrategySignal> signals;

    const bool has_binary_prices = valid_price(snapshot.yes_ask) && valid_price(snapshot.no_ask);
    if (has_binary_prices)
    {
        const double combined = snapshot.yes_ask + snapshot.no_ask;
        const double depth = std::min(
            ask_depth_usdc(snapshot.yes_ask, snapshot.yes_ask_size),
            ask_depth_usdc(snapshot.no_ask, snapshot.no_ask_size));

        if (combined < config.arb_threshold && depth >= config.min_depth_usd)
        {
            StrategySignal signal;
            signal.type = SignalType::BinaryArbitrage;
            signal.slug = snapshot.slug;
            signal.reason = "YES ask plus NO ask is below redemption value";
            signal.combined_ask = combined;
            signal.edge_cents = (1.0 - combined) * 100.0;
            signal.executable_depth_usdc = depth;
            signal.score = std::clamp(signal.edge_cents * 10.0 + depth / 10.0, 0.0, 100.0);
            signal.paper_trade = project_binary_arb(snapshot, config.paper_stake_usdc);
            signals.push_back(signal);
        }
    }

    const double yes_spread = spread_bps(snapshot.yes_bid, snapshot.yes_ask);
    const double yes_depth = ask_depth_usdc(snapshot.yes_ask, snapshot.yes_ask_size);
    if (yes_spread >= config.min_market_making_spread_bps && yes_depth >= config.min_depth_usd)
    {
        StrategySignal signal;
        signal.type = SignalType::MarketMakingCandidate;
        signal.slug = snapshot.slug;
        signal.reason = "YES book has enough spread and visible top-of-book depth";
        signal.edge_cents = (snapshot.yes_ask - snapshot.yes_bid) * 100.0;
        signal.executable_depth_usdc = yes_depth;
        signal.score = std::clamp(yes_spread / 25.0 + yes_depth / 25.0, 0.0, 100.0);
        signals.push_back(signal);
    }

    return signals;
}

const StrategySignal *find_signal(
    const std::vector<StrategySignal> &signals,
    SignalType type)
{
    for (const auto &signal : signals)
    {
        if (signal.type == type)
        {
            return &signal;
        }
    }
    return nullptr;
}

std::string signal_type_name(SignalType type)
{
    switch (type)
    {
    case SignalType::BinaryArbitrage:
        return "binary_arbitrage";
    case SignalType::MarketMakingCandidate:
        return "market_making_candidate";
    }
    return "unknown";
}
} // namespace polyarb
