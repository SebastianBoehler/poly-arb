#include <discovery_options.hpp>

#include <stdexcept>

namespace polyarb
{
namespace
{
int next_int(const std::vector<std::string> &args, std::size_t &i)
{
    if (i + 1 >= args.size())
    {
        throw std::invalid_argument("missing value for " + args[i]);
    }
    return std::stoi(args[++i]);
}

double next_double(const std::vector<std::string> &args, std::size_t &i)
{
    if (i + 1 >= args.size())
    {
        throw std::invalid_argument("missing value for " + args[i]);
    }
    return std::stod(args[++i]);
}
} // namespace

DiscoveryOptions parse_discovery_options(const std::vector<std::string> &args)
{
    DiscoveryOptions options;
    for (std::size_t i = 1; i < args.size(); ++i)
    {
        const std::string &arg = args[i];
        if (arg == "--help")
        {
            options.show_help = true;
        }
        else if (arg == "--15m")
        {
            options.crypto_15m = true;
        }
        else if (arg == "--signals-only")
        {
            options.signals_only = true;
        }
        else if (arg == "--max")
        {
            options.max_markets = next_int(args, i);
        }
        else if (arg == "--iterations")
        {
            options.max_iterations = next_int(args, i);
        }
        else if (arg == "--interval-ms")
        {
            options.interval_ms = next_int(args, i);
        }
        else if (arg == "--duration-sec")
        {
            options.max_runtime_ms = static_cast<int64_t>(next_double(args, i) * 1000.0);
        }
        else if (arg == "--duration-min")
        {
            options.max_runtime_ms = static_cast<int64_t>(next_double(args, i) * 60'000.0);
        }
        else if (arg == "--duration-hours")
        {
            options.max_runtime_ms = static_cast<int64_t>(next_double(args, i) * 3'600'000.0);
        }
        else if (arg == "--arb-threshold")
        {
            options.strategy.arb_threshold = next_double(args, i);
        }
        else if (arg == "--min-depth-usd")
        {
            options.strategy.min_depth_usd = next_double(args, i);
        }
        else if (arg == "--paper-stake-usdc")
        {
            options.strategy.paper_stake_usdc = next_double(args, i);
        }
        else if (arg == "--out")
        {
            if (i + 1 >= args.size())
            {
                throw std::invalid_argument("missing value for --out");
            }
            options.output_path = args[++i];
        }
        else
        {
            throw std::invalid_argument("unknown option: " + arg);
        }
    }
    return options;
}

bool should_continue_discovery(
    int completed_iterations,
    std::chrono::steady_clock::time_point started_at,
    const DiscoveryOptions &options)
{
    if (options.max_iterations && completed_iterations >= *options.max_iterations)
    {
        return false;
    }
    if (options.max_runtime_ms)
    {
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started_at);
        if (elapsed.count() >= *options.max_runtime_ms)
        {
            return false;
        }
    }
    return true;
}

std::string discovery_usage()
{
    return "Usage: discovery_mode [--15m] [--max N] [--iterations N] "
           "[--duration-sec N|--duration-min N|--duration-hours N] "
           "[--interval-ms N] [--arb-threshold N] [--min-depth-usd N] "
           "[--paper-stake-usdc N] [--signals-only] [--out FILE]\n"
           "\nDefault: run until SIGINT/SIGTERM. Use --iterations or --duration-* "
           "for bounded smoke or scheduled runs.\n";
}
} // namespace polyarb
