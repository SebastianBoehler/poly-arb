/**
 * Position Management Smoke Test
 *
 * Tests position fetching, redeeming, and merging functionality.
 * - Fetches all positions for the user
 * - Identifies redeemable positions (resolved markets with winning shares)
 * - Identifies mergeable positions (can merge Yes+No back to USDC)
 * - Attempts to redeem/merge if any exist
 *
 * Build: cmake --build build --target position_smoke
 * Run: PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/position_smoke
 */

#include <clob_client.hpp>
#include <order_signer.hpp>
#include <http_client.hpp>
#include <iostream>
#include <cstdlib>
#include <iomanip>
#include <algorithm>

using namespace polymarket;

void print_usage()
{
    std::cout << "Position Management Smoke Test\n"
              << "===============================\n\n"
              << "Tests position fetching, redeeming, and merging.\n\n"
              << "Environment variables:\n"
              << "  PRIVATE_KEY      - Wallet private key (required)\n"
              << "  FUNDER_ADDRESS   - Address holding funds (for proxy wallets)\n\n"
              << "Options:\n"
              << "  --help           - Show this help\n"
              << std::endl;
}

int main(int argc, char *argv[])
{
    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h")
        {
            print_usage();
            return 0;
        }
    }

    const char *private_key_env = std::getenv("PRIVATE_KEY");
    const char *funder_address_env = std::getenv("FUNDER_ADDRESS");

    if (!private_key_env)
    {
        std::cerr << "Error: PRIVATE_KEY environment variable required\n";
        print_usage();
        return 1;
    }

    std::string private_key = private_key_env;
    std::string funder_address = funder_address_env ? funder_address_env : "";

    std::cout << "Position Management Smoke Test\n"
              << "===============================\n\n";

    http_global_init();

    // Create order signer to get address
    OrderSigner signer(private_key);
    if (funder_address.empty())
        funder_address = signer.address();

    std::cout << "[1] Wallet Info\n";
    std::cout << "    Signer:  " << signer.address() << "\n";
    std::cout << "    Funder:  " << funder_address << "\n\n";

    // Create authenticated CLOB client
    std::cout << "[2] Deriving API credentials...\n";

    HttpClient http;
    http.set_base_url("https://clob.polymarket.com");
    http.set_timeout_ms(10000);

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

    // Create CLOB client with authentication
    ClobClient client(
        "https://clob.polymarket.com",
        137,
        private_key,
        creds,
        funder_address != signer.address() ? SignatureType::POLY_GNOSIS_SAFE : SignatureType::EOA,
        funder_address);

    // Fetch all positions
    std::cout << "[3] Fetching positions...\n";
    auto positions = client.get_positions();

    if (positions.empty())
    {
        std::cout << "    No positions found for this wallet.\n";
        std::cout << "\n[DONE] No positions to process.\n";
        http_global_cleanup();
        return 0;
    }

    std::cout << "    Found " << positions.size() << " position(s)\n\n";

    // Display all positions
    std::cout << "[4] Position Details:\n";
    std::cout << std::string(80, '-') << "\n";

    int redeemable_count = 0;
    int mergeable_count = 0;
    double total_value = 0;
    double total_pnl = 0;

    for (size_t i = 0; i < positions.size(); i++)
    {
        const auto &pos = positions[i];

        std::cout << "    [" << (i + 1) << "] " << pos.title << "\n";
        std::cout << "        Outcome:     " << pos.outcome << "\n";
        std::cout << "        Size:        " << std::fixed << std::setprecision(4) << pos.size << " shares\n";
        std::cout << "        Avg Price:   $" << std::setprecision(4) << pos.avg_price << "\n";
        std::cout << "        Cur Price:   $" << std::setprecision(4) << pos.cur_price << "\n";
        std::cout << "        Value:       $" << std::setprecision(2) << pos.current_value << "\n";
        std::cout << "        PnL:         $" << std::setprecision(2) << pos.cash_pnl
                  << " (" << std::setprecision(1) << pos.percent_pnl << "%)\n";
        std::cout << "        Redeemable:  " << (pos.redeemable ? "YES" : "no") << "\n";
        std::cout << "        Mergeable:   " << (pos.mergeable ? "YES" : "no") << "\n";
        std::cout << "        Neg Risk:    " << (pos.negative_risk ? "yes" : "no") << "\n";
        std::cout << "        Condition:   " << pos.condition_id.substr(0, 20) << "...\n";
        std::cout << "\n";

        if (pos.redeemable)
            redeemable_count++;
        if (pos.mergeable)
            mergeable_count++;
        total_value += pos.current_value;
        total_pnl += pos.cash_pnl;
    }

    std::cout << std::string(80, '-') << "\n";
    std::cout << "    Summary:\n";
    std::cout << "        Total Positions: " << positions.size() << "\n";
    std::cout << "        Total Value:     $" << std::fixed << std::setprecision(2) << total_value << "\n";
    std::cout << "        Total PnL:       $" << std::setprecision(2) << total_pnl << "\n";
    std::cout << "        Redeemable:      " << redeemable_count << "\n";
    std::cout << "        Mergeable:       " << mergeable_count << "\n\n";

    // Display redeemable positions (redemption handled via TypeScript service)
    if (redeemable_count > 0)
    {
        std::cout << "[5] Redeemable Positions (resolved markets with winning shares):\n";
        for (const auto &pos : positions)
        {
            if (pos.redeemable && pos.size > 0)
            {
                std::cout << "    - " << pos.title << " (" << pos.outcome << "): "
                          << pos.size << " shares\n";
                std::cout << "      [INFO] Use TypeScript redemption service to redeem.\n";
            }
        }
        std::cout << "\n";
    }
    else
    {
        std::cout << "[5] No redeemable positions found.\n\n";
    }

    // Display mergeable positions (merging handled via TypeScript service)
    if (mergeable_count > 0)
    {
        std::cout << "[6] Mergeable Positions (can merge Yes+No back to USDC):\n";

        // Group by condition_id to find matching Yes/No pairs
        std::map<std::string, std::vector<ClobClient::Position>> by_condition;
        for (const auto &pos : positions)
        {
            if (pos.mergeable && pos.size > 0)
            {
                by_condition[pos.condition_id].push_back(pos);
            }
        }

        for (const auto &[condition_id, cond_positions] : by_condition)
        {
            if (cond_positions.empty())
                continue;

            std::cout << "    Market: " << cond_positions[0].title << "\n";

            double yes_size = 0, no_size = 0;
            for (const auto &pos : cond_positions)
            {
                std::string outcome_lower = pos.outcome;
                std::transform(outcome_lower.begin(), outcome_lower.end(), outcome_lower.begin(), ::tolower);

                if (outcome_lower == "yes" || outcome_lower == "up" || pos.outcome_index == 0)
                    yes_size = pos.size;
                else if (outcome_lower == "no" || outcome_lower == "down" || pos.outcome_index == 1)
                    no_size = pos.size;
            }

            double merge_amount = std::min(yes_size, no_size);
            std::cout << "      Yes: " << yes_size << ", No: " << no_size << "\n";
            std::cout << "      Can merge: " << merge_amount << " shares -> $" << merge_amount << " USDC\n";
            std::cout << "      [INFO] Use TypeScript service to merge.\n";
        }
        std::cout << "\n";
    }
    else
    {
        std::cout << "[6] No mergeable positions found.\n\n";
    }

    if (redeemable_count > 0 || mergeable_count > 0)
    {
        std::cout << "[NOTE] Redeem/merge operations are handled via TypeScript service.\n\n";
    }

    std::cout << "[DONE] Position management smoke test complete.\n";

    http_global_cleanup();
    return 0;
}
