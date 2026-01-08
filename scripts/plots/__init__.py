# Plot submodules for stats analysis
from .common import setup_deepseek_style, DEEPSEEK_COLORS
from .hit_rates import plot_hit_rates, plot_market_inefficiency, plot_inefficiency_by_symbol
from .prices import plot_avg_prices_by_threshold, plot_avg_prices_by_symbol, plot_price_distribution_analysis
from .frequency import plot_opportunity_frequency, plot_opportunity_timeline
from .time_buckets import plot_time_bucket_distribution, plot_time_bucket_heatmap
from .liquidity import plot_liquidity_by_threshold, plot_liquidity_timeline
from .duration import plot_duration_by_threshold, plot_duration_timeline, plot_duration_distribution, plot_duration_by_expiry, plot_duration_by_expiry_lines
from .lowprice import plot_lowprice_heatmap

__all__ = [
    'setup_deepseek_style',
    'DEEPSEEK_COLORS',
    'plot_hit_rates',
    'plot_market_inefficiency',
    'plot_inefficiency_by_symbol',
    'plot_avg_prices_by_threshold',
    'plot_avg_prices_by_symbol',
    'plot_price_distribution_analysis',
    'plot_opportunity_frequency',
    'plot_opportunity_timeline',
    'plot_time_bucket_distribution',
    'plot_time_bucket_heatmap',
    'plot_liquidity_by_threshold',
    'plot_liquidity_timeline',
    'plot_duration_by_threshold',
    'plot_duration_timeline',
    'plot_duration_distribution',
    'plot_duration_by_expiry',
    'plot_duration_by_expiry_lines',
    'plot_lowprice_heatmap',
]
