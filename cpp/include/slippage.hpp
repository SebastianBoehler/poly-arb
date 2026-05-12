#pragma once

#include <types.hpp>

#include <vector>

namespace polyarb
{
struct FillSimulation
{
    bool fillable{false};
    double requested_shares{0.0};
    double filled_shares{0.0};
    double unfilled_shares{0.0};
    double spent_usdc{0.0};
    double avg_price{0.0};
    double best_price{0.0};
    double slippage_bps{0.0};
};

struct BinaryBundleSimulation
{
    bool fillable{false};
    double requested_bundles{0.0};
    FillSimulation yes;
    FillSimulation no;
    double combined_avg_price{0.0};
    double combined_best_price{0.0};
    double edge_cents{0.0};
};

FillSimulation simulate_buy_shares(
    const std::vector<polymarket::PriceLevel> &asks,
    double target_shares);

BinaryBundleSimulation simulate_binary_bundle_buy(
    const std::vector<polymarket::PriceLevel> &yes_asks,
    const std::vector<polymarket::PriceLevel> &no_asks,
    double target_bundles);
} // namespace polyarb
