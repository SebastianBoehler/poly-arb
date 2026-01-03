/**
 * Order Placement Benchmark - C++
 *
 * Benchmarks raw order placement latency (sign + post) for $1 orders.
 * Uses pre-cached neg_risk to skip API calls during order creation.
 *
 * Build: cmake --build build --target order_benchmark
 * Run: PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/order_benchmark
 *
 * Env:
 *   PRIVATE_KEY      - Wallet private key (required)
 *   FUNDER_ADDRESS   - Address holding funds (for proxy wallets)
 *   NUM_ORDERS       - Number of orders to benchmark (default: 5)
 */

#include "order_signer.hpp"
#include "http_client.hpp"
#include <nlohmann/json.hpp>
#include <iostream>
#include <cstdlib>
#include <chrono>
#include <iomanip>
#include <vector>
#include <numeric>
#include <algorithm>
#include <thread>

using json = nlohmann::json;
using namespace polymarket;

const std::string CLOB_API = "https://clob.polymarket.com";
const std::string NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const std::string CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

struct BenchmarkResult
{
    int iteration;
    double sign_ms;
    double post_ms;
    double total_ms;
    bool success;
    std::string error_msg;
};

int main(int argc, char *argv[])
{
    const char *private_key_env = std::getenv("PRIVATE_KEY");
    const char *funder_address_env = std::getenv("FUNDER_ADDRESS");
    const char *num_orders_env = std::getenv("NUM_ORDERS");

    if (!private_key_env)
    {
        std::cerr << "Error: PRIVATE_KEY environment variable required\n";
        return 1;
    }

    std::string private_key = private_key_env;
    std::string funder_address = funder_address_env ? funder_address_env : "";
    int num_orders = num_orders_env ? std::stoi(num_orders_env) : 5;

    std::cout << "=== C++ Order Placement Benchmark ===\n\n";

    // Initialize signer
    OrderSigner signer(private_key);
    if (funder_address.empty())
    {
        funder_address = signer.address();
    }

    std::cout << "Signer: " << signer.address() << "\n";
    std::cout << "Funder: " << funder_address << "\n";
    std::cout << "Orders to benchmark: " << num_orders << "\n\n";

    http_global_init();
    HttpClient http;
    http.set_base_url(CLOB_API);
    http.set_timeout_ms(10000);

    // Derive API credentials
    std::cout << "Deriving API credentials...\n";
    ApiCredentials creds;
    try
    {
        creds = signer.create_or_derive_api_credentials(http, funder_address);
        std::cout << "API key: " << creds.api_key.substr(0, 8) << "...\n\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "Failed: " << e.what() << "\n";
        http_global_cleanup();
        return 1;
    }

    // Find active BTC 15m market
    std::cout << "Finding active BTC 15m market...\n";

    uint64_t now_ts = static_cast<uint64_t>(std::time(nullptr));
    uint64_t current_window = (now_ts / 900) * 900;

    std::string token_id;
    double best_ask = 0;
    bool is_neg_risk = false;
    std::string exchange_address;

    for (int i = 0; i <= 3; i++)
    {
        uint64_t start_ts = current_window + i * 900;
        uint64_t exp_ts = start_ts + 900;
        if (exp_ts <= now_ts + 120)
            continue;

        std::string slug = "btc-updown-15m-" + std::to_string(start_ts);

        HttpClient gamma_http;
        gamma_http.set_base_url("https://gamma-api.polymarket.com");
        gamma_http.set_timeout_ms(10000);

        auto gamma_response = gamma_http.get("/events?slug=" + slug);
        if (!gamma_response.ok())
            continue;

        try
        {
            auto gamma_json = json::parse(gamma_response.body);
            if (!gamma_json.is_array() || gamma_json.empty())
                continue;

            auto &event = gamma_json[0];
            if (!event.contains("markets") || event["markets"].empty())
                continue;

            auto &mkt = event["markets"][0];
            auto token_ids = json::parse(mkt["clobTokenIds"].get<std::string>());
            token_id = token_ids[0].get<std::string>(); // YES token

            // Get orderbook for best ask
            auto book_response = http.get("/book?token_id=" + token_id);
            if (!book_response.ok())
                continue;

            auto book_json = json::parse(book_response.body);
            if (!book_json.contains("asks") || book_json["asks"].empty())
                continue;

            best_ask = std::stod(book_json["asks"][0]["price"].get<std::string>());

            // Get neg_risk (cache it once)
            auto neg_risk_response = http.get("/neg-risk?token_id=" + token_id);
            if (neg_risk_response.ok())
            {
                auto neg_risk_json = json::parse(neg_risk_response.body);
                is_neg_risk = neg_risk_json.value("neg_risk", false);
            }

            exchange_address = is_neg_risk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

            uint64_t time_left = (exp_ts - now_ts) / 60;
            std::cout << "Found: " << slug << " (expires in " << time_left << "min)\n";
            std::cout << "Token: " << token_id.substr(0, 30) << "...\n";
            std::cout << "Best ask: " << best_ask << "\n";
            std::cout << "Neg risk: " << (is_neg_risk ? "true" : "false") << "\n\n";
            break;
        }
        catch (...)
        {
            continue;
        }
    }

    if (token_id.empty())
    {
        std::cerr << "Could not find active market\n";
        http_global_cleanup();
        return 1;
    }

    // Benchmark loop
    std::cout << "Starting benchmark...\n\n";
    std::cout << "| Iter | Sign (ms) | Post (ms) | Total (ms) | Success |\n";
    std::cout << "|------|-----------|-----------|------------|---------|" << std::endl;

    std::vector<BenchmarkResult> results;

    for (int i = 0; i < num_orders; i++)
    {
        double price = 0.50;    // Fixed price for benchmark
        double size_usdc = 5.0; // $5 minimum for market orders
        double shares = 10.0;   // $5 at 0.50 = 10 shares

        // Time the sign phase
        auto sign_start = std::chrono::high_resolution_clock::now();

        OrderData order_data;
        order_data.maker = funder_address;
        order_data.taker = "0x0000000000000000000000000000000000000000";
        order_data.token_id = token_id;
        order_data.maker_amount = to_wei(size_usdc, 6);
        order_data.taker_amount = to_wei(shares, 6);
        order_data.side = OrderSide::BUY;
        order_data.fee_rate_bps = "0";
        order_data.nonce = "0";
        order_data.signer = signer.address();
        order_data.expiration = "0";
        order_data.signature_type = (funder_address != signer.address())
                                        ? SignatureType::POLY_GNOSIS_SAFE
                                        : SignatureType::EOA;

        // Use cached exchange_address (no API call!)
        auto signed_order = signer.sign_order(order_data, exchange_address);

        auto sign_end = std::chrono::high_resolution_clock::now();
        double sign_ms = std::chrono::duration<double, std::milli>(sign_end - sign_start).count();

        // Build order payload
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
        payload["orderType"] = "GTC"; // Use GTC so order posts even without liquidity match
        payload["owner"] = creds.api_key;

        std::string body_str = payload.dump();

        // Generate L2 headers
        auto l2_hdrs = signer.generate_l2_headers(creds, "POST", "/order", body_str, funder_address);
        std::map<std::string, std::string> headers = {
            {"POLY_ADDRESS", l2_hdrs.poly_address},
            {"POLY_SIGNATURE", l2_hdrs.poly_signature},
            {"POLY_TIMESTAMP", l2_hdrs.poly_timestamp},
            {"POLY_API_KEY", l2_hdrs.poly_api_key},
            {"POLY_PASSPHRASE", l2_hdrs.poly_passphrase}};

        // Time the post phase
        auto post_start = std::chrono::high_resolution_clock::now();
        auto response = http.post("/order", body_str, headers);
        auto post_end = std::chrono::high_resolution_clock::now();
        double post_ms = std::chrono::duration<double, std::milli>(post_end - post_start).count();

        double total_ms = sign_ms + post_ms;

        bool success = false;
        std::string error_msg;

        if (response.ok())
        {
            try
            {
                auto result = json::parse(response.body);
                success = result.value("success", false) && result.value("errorMsg", "") == "";
                error_msg = result.value("errorMsg", "");
                if (!success && error_msg.empty())
                {
                    error_msg = response.body.substr(0, 100);
                }
            }
            catch (...)
            {
                error_msg = "parse error: " + response.body.substr(0, 100);
            }
        }
        else
        {
            error_msg = "HTTP " + std::to_string(response.status_code) + ": " + response.body.substr(0, 100);
        }

        // Debug: print error for first order
        if (i == 0 && !success)
        {
            std::cerr << "DEBUG first order error: " << error_msg << "\n\n";
        }

        results.push_back({i + 1, sign_ms, post_ms, total_ms, success, error_msg});

        std::cout << "| " << std::setw(4) << (i + 1)
                  << " | " << std::setw(9) << std::fixed << std::setprecision(1) << sign_ms
                  << " | " << std::setw(9) << post_ms
                  << " | " << std::setw(10) << total_ms
                  << " | " << (success ? "  ✓  " : "  ✗  ") << " |" << std::endl;

        // Small delay between orders
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Summary
    std::cout << "\n=== Summary ===\n";

    double avg_sign = 0, avg_post = 0, avg_total = 0;
    double min_total = results[0].total_ms, max_total = results[0].total_ms;
    int success_count = 0;

    for (const auto &r : results)
    {
        avg_sign += r.sign_ms;
        avg_post += r.post_ms;
        avg_total += r.total_ms;
        min_total = std::min(min_total, r.total_ms);
        max_total = std::max(max_total, r.total_ms);
        if (r.success)
            success_count++;
    }

    avg_sign /= results.size();
    avg_post /= results.size();
    avg_total /= results.size();
    double success_rate = (static_cast<double>(success_count) / results.size()) * 100;

    std::cout << "Average sign time:  " << std::fixed << std::setprecision(1) << avg_sign << " ms\n";
    std::cout << "Average post time:  " << avg_post << " ms\n";
    std::cout << "Average total time: " << avg_total << " ms\n";
    std::cout << "Min total time:     " << min_total << " ms\n";
    std::cout << "Max total time:     " << max_total << " ms\n";
    std::cout << "Success rate:       " << std::setprecision(0) << success_rate << "%\n";

    // Output JSON for comparison
    std::cout << "\n=== JSON Output ===\n";
    json output;
    output["implementation"] = "cpp";
    output["numOrders"] = num_orders;
    output["avgSignMs"] = avg_sign;
    output["avgPostMs"] = avg_post;
    output["avgTotalMs"] = avg_total;
    output["minTotalMs"] = min_total;
    output["maxTotalMs"] = max_total;
    output["successRate"] = success_rate;
    std::cout << output.dump(2) << std::endl;

    http_global_cleanup();
    return 0;
}
