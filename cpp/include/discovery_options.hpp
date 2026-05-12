#pragma once

#include <example_strategies.hpp>
#include <types.hpp>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

namespace polyarb
{
struct DiscoveryOptions
{
    int max_markets{50};
    std::optional<int> max_iterations;
    std::optional<int64_t> max_runtime_ms;
    int interval_ms{1000};
    bool crypto_15m{false};
    bool signals_only{false};
    bool show_help{false};
    std::string output_path;
    StrategyConfig strategy;
};

DiscoveryOptions parse_discovery_options(const std::vector<std::string> &args);

bool should_continue_discovery(
    int completed_iterations,
    std::chrono::steady_clock::time_point started_at,
    const DiscoveryOptions &options);

bool is_discovery_candidate(const polymarket::ClobMarket &market);

std::string discovery_usage();
} // namespace polyarb
