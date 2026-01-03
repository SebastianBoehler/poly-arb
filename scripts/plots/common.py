"""Common utilities and styling for plots."""
from __future__ import annotations

import matplotlib.pyplot as plt
from typing import List
import pandas as pd


# DeepSeek-style blue palette (light to medium blues)
DEEPSEEK_COLORS = [
    '#1a3a5c',  # dark navy
    '#2d5a87',  # medium navy  
    '#4a7fb8',  # medium blue
    '#6b9fd4',  # light blue
    '#8bbde8',  # lighter blue
    '#acd4f4',  # very light blue
    '#cce7fc',  # pale blue
]


def setup_deepseek_style():
    """Configure matplotlib to match DeepSeek paper chart aesthetics."""
    plt.rcParams.update({
        'font.family': 'sans-serif',
        'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
        'font.size': 10,
        'axes.titlesize': 12,
        'axes.titleweight': 'bold',
        'axes.labelsize': 10,
        'axes.spines.top': False,
        'axes.spines.right': False,
        'axes.spines.left': True,
        'axes.spines.bottom': True,
        'axes.linewidth': 0.8,
        'axes.edgecolor': '#333333',
        'xtick.labelsize': 9,
        'ytick.labelsize': 9,
        'legend.fontsize': 8,
        'legend.frameon': True,
        'legend.edgecolor': '#cccccc',
        'legend.fancybox': False,
        'figure.facecolor': 'white',
        'axes.facecolor': 'white',
        'axes.grid': True,
        'grid.alpha': 0.3,
        'grid.linestyle': '-',
        'grid.linewidth': 0.5,
        'grid.color': '#cccccc',
    })


def threshold_cols(df: pd.DataFrame) -> List[str]:
    """Get threshold hit columns from dataframe."""
    return [c for c in df.columns if c.startswith("hits_le_")]


def avg_yes_cols(df: pd.DataFrame) -> List[str]:
    """Get average YES price columns from dataframe."""
    return [c for c in df.columns if c.startswith("avg_yes_le_")]


def avg_no_cols(df: pd.DataFrame) -> List[str]:
    """Get average NO price columns from dataframe."""
    return [c for c in df.columns if c.startswith("avg_no_le_")]
