/**
 * Batch Order Smoke Test
 *
 * Tests batch order placement by placing YES and NO orders at best offer prices.
 * Verifies if orders fill quickly enough to take the best offer in both markets.
 *
 * Build: cmake --build build --target batch_order_smoke
 * Run: PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/batch_order_smoke
 */

#include "order_signer.hpp"
#include "http_client.hpp"
#include <nlohmann/json.hpp>
#include <iostream>
#include <cstdlib>
#include <chrono>
#include <iomanip>
#include <map>

using json = nlohmann::json;
using namespace polymarket;

const std::string CLOB_API = "https://clob.polymarket.com";
const std::string NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const std::string CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

void print_usage()
{
    std::cout << "Batch Order Smoke Test\n"
              << "======================\n\n"
              << "Tests batch order placement at best offer prices.\n\n"
              << "Environment variables:\n"
              << "  PRIVATE_KEY      - Wallet private key (required)\n"
              << "  FUNDER_ADDRESS   - Address holding funds (for proxy wallets)\n"
              << "  SIZE_USDC        - Size per leg in USDC (default: 1)\n\n"
              << "Options:\n"
              << "  --help           - Show this help\n"
              << "  --dry-run        - Don't actually place orders (default)\n"
              << "  --live           - Actually place orders\n"
              << std::endl;
}

int main(int argc, char *argv[])
{
    bool dry_run = true;

    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h")
        {
            print_usage();
            return 0;
        }
        if (arg == "--live")
            dry_run = false;
        if (arg == "--dry-run")
            dry_run = true;
    }

    const char *private_key_env = std::getenv("PRIVATE_KEY");
    const char *funder_address_env = std::getenv("FUNDER_ADDRESS");
    const char *size_usdc_env = std::getenv("SIZE_USDC");

    if (!private_key_env)
    {
        std::cerr << "Error: PRIVATE_KEY environment variable required\n";
        print_usage();
        return 1;
    }

    std::string private_key = private_key_env;
    std::string funder_address = funder_address_env ? funder_address_env : "";
    double size_usdc = size_usdc_env ? std::stod(size_usdc_env) : 1.0;

    std::cout << "Batch Order Smoke Test\n======================\n\n";
    std::cout << "Mode: " << (dry_run ? "DRY-RUN" : "LIVE") << "\n";
    std::cout << "Size per leg: $" << size_usdc << "\n\n";

    OrderSigner signer(private_key);
    if (funder_address.empty())
        funder_address = signer.address();

    std::cout << "[1] Signer: " << signer.address() << "\n";
    std::cout << "    Funder: " << funder_address << "\n\n";

    http_global_init();
    HttpClient http;
    http.set_base_url(CLOB_API);
    http.set_timeout_ms(10000);

    std::cout << "[2] Deriving API credentials...\n";
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

    std::cout << "[3] Finding active BTC 15m market...\n";

    uint64_t now_ts = static_cast<uint64_t>(std::time(nullptr));
    uint64_t current_window = (now_ts / 900) * 900;

    std::string slug, yes_token, no_token;
    double best_ask_yes = 0, best_ask_no = 0;
    double best_ask_size_yes = 0, best_ask_size_no = 0;
    bool is_neg_risk = false;

    for (int i = 0; i <= 3; i++)
    {
        uint64_t start_ts = current_window + i * 900;
        uint64_t exp_ts = start_ts + 900;
        if (exp_ts <= now_ts + 120)
            continue;

        slug = "btc-updown-15m-" + std::to_string(start_ts);

        HttpClient gamma_http;
        gamma_http.set_base_url("https://gamma-api.polymarket.com");
        gamma_http.set_timeout_ms(10000);

        auto gamma_response = gamma_http.get("/events?slug=" + slug);
        if (!gamma_response.ok())
            continue;

        auto gamma_json = json::parse(gamma_response.body);
        if (!gamma_json.is_array() || gamma_json.empty())
            continue;

        auto &event = gamma_json[0];
        if (!event.contains("markets") || event["markets"].empty())
            continue;

        auto &mkt = event["markets"][0];
        auto token_ids = json::parse(mkt["clobTokenIds"].get<std::string>());
        yes_token = token_ids[0].get<std::string>();
        no_token = token_ids[1].get<std::string>();

        auto yes_book = http.get("/book?token_id=" + yes_token);
        auto no_book = http.get("/book?token_id=" + no_token);

        if (!yes_book.ok() || !no_book.ok())
            continue;

        auto yes_json = json::parse(yes_book.body);
        auto no_json = json::parse(no_book.body);

        if (!yes_json.contains("asks") || yes_json["asks"].empty() ||
            !no_json.contains("asks") || no_json["asks"].empty())
        {
            std::cout << "    Skipping " << slug << " - no liquidity\n";
            continue;
        }

        best_ask_yes = std::stod(yes_json["asks"][0]["price"].get<std::string>());
        best_ask_no = std::stod(no_json["asks"][0]["price"].get<std::string>());
        best_ask_size_yes = std::stod(yes_json["asks"][0]["size"].get<std::string>());
        best_ask_size_no = std::stod(no_json["asks"][0]["size"].get<std::string>());

        auto neg_risk_response = http.get("/neg-risk?token_id=" + yes_token);
        if (neg_risk_response.ok())
        {
            auto neg_risk_json = json::parse(neg_risk_response.body);
            is_neg_risk = neg_risk_json.value("neg_risk", false);
        }

        uint64_t time_left = exp_ts - now_ts;
        std::cout << "    Found: " << slug << " (expires in " << time_left / 60 << "min)\n";
        break;
    }

    if (yes_token.empty())
    {
        std::cerr << "    Could not find active market with liquidity\n";
        http_global_cleanup();
        return 1;
    }

    std::cout << "\n[4] Market details:\n";
    std::cout << "    YES token: " << yes_token.substr(0, 30) << "...\n";
    std::cout << "    NO token:  " << no_token.substr(0, 30) << "...\n";
    std::cout << "    Best ask YES: " << best_ask_yes << " (size: " << best_ask_size_yes << ")\n";
    std::cout << "    Best ask NO:  " << best_ask_no << " (size: " << best_ask_size_no << ")\n";
    std::cout << "    Combined:     " << (best_ask_yes + best_ask_no) << "\n";
    std::cout << "    neg_risk:     " << (is_neg_risk ? "true" : "false") << "\n";

    double yes_price = best_ask_yes;
    double no_price = best_ask_no;
    double yes_shares = std::floor((size_usdc / yes_price) * 10000) / 10000;
    double no_shares = std::floor((size_usdc / no_price) * 10000) / 10000;

    std::cout << "\n[5] Order details (at best offer):\n";
    std::cout << "    YES: $" << size_usdc << " @ " << yes_price << " = " << yes_shares << " shares\n";
    std::cout << "    NO:  $" << size_usdc << " @ " << no_price << " = " << no_shares << " shares\n";

    if (dry_run)
    {
        std::cout << "\n[DRY RUN] Would place batch order - use --live to execute\n";
        http_global_cleanup();
        return 0;
    }

    std::cout << "\n[6] Creating and signing orders...\n";
    auto sign_start = std::chrono::high_resolution_clock::now();

    std::string exchange_addr = is_neg_risk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

    OrderData yes_order;
    yes_order.maker = funder_address;
    yes_order.taker = "0x0000000000000000000000000000000000000000";
    yes_order.token_id = yes_token;
    yes_order.maker_amount = to_wei(size_usdc, 6);
    yes_order.taker_amount = to_wei(yes_shares, 6);
    yes_order.side = OrderSide::BUY;
    yes_order.fee_rate_bps = "0";
    yes_order.nonce = "0";
    yes_order.signer = signer.address();
    yes_order.expiration = "0";
    yes_order.signature_type = (funder_address != signer.address())
                                   ? SignatureType::POLY_GNOSIS_SAFE
                                   : SignatureType::EOA;

    OrderData no_order;
    no_order.maker = funder_address;
    no_order.taker = "0x0000000000000000000000000000000000000000";
    no_order.token_id = no_token;
    no_order.maker_amount = to_wei(size_usdc, 6);
    no_order.taker_amount = to_wei(no_shares, 6);
    no_order.side = OrderSide::BUY;
    no_order.fee_rate_bps = "0";
    no_order.nonce = "0";
    no_order.signer = signer.address();
    no_order.expiration = "0";
    no_order.signature_type = (funder_address != signer.address())
                                  ? SignatureType::POLY_GNOSIS_SAFE
                                  : SignatureType::EOA;

    auto yes_signed = signer.sign_order(yes_order, exchange_addr);
    auto no_signed = signer.sign_order(no_order, exchange_addr);

    auto sign_end = std::chrono::high_resolution_clock::now();
    auto sign_duration = std::chrono::duration_cast<std::chrono::microseconds>(sign_end - sign_start);
    std::cout << "    Signing took: " << sign_duration.count() << " us\n";

    // Build batch payload using ordered_json (same format as arb_test)
    auto build_order_payload = [&creds](const SignedOrder &order, const std::string &order_type) -> nlohmann::ordered_json
    {
        nlohmann::ordered_json payload;
        nlohmann::ordered_json order_obj;
        order_obj["salt"] = std::stoll(order.salt);
        order_obj["maker"] = order.maker;
        order_obj["signer"] = order.signer;
        order_obj["taker"] = order.taker;
        order_obj["tokenId"] = order.token_id;
        order_obj["makerAmount"] = order.maker_amount;
        order_obj["takerAmount"] = order.taker_amount;
        order_obj["side"] = "BUY";
        order_obj["expiration"] = order.expiration;
        order_obj["nonce"] = order.nonce;
        order_obj["feeRateBps"] = order.fee_rate_bps;
        order_obj["signatureType"] = static_cast<int>(order.signature_type);
        order_obj["signature"] = order.signature;
        payload["deferExec"] = false;
        payload["order"] = order_obj;
        payload["owner"] = creds.api_key;
        payload["orderType"] = order_type;
        return payload;
    };

    auto yes_payload = build_order_payload(yes_signed, "FOK");
    auto no_payload = build_order_payload(no_signed, "FOK");

    json batch_payload = json::array();
    batch_payload.push_back(json::parse(yes_payload.dump()));
    batch_payload.push_back(json::parse(no_payload.dump()));

    std::cout << "\n[7] Posting batch order (FOK)...\n";

    std::string body_str = batch_payload.dump();
    auto l2_hdrs = signer.generate_l2_headers(creds, "POST", "/orders", body_str, funder_address);
    std::map<std::string, std::string> l2_headers = {
        {"POLY_ADDRESS", l2_hdrs.poly_address},
        {"POLY_SIGNATURE", l2_hdrs.poly_signature},
        {"POLY_TIMESTAMP", l2_hdrs.poly_timestamp},
        {"POLY_API_KEY", l2_hdrs.poly_api_key},
        {"POLY_PASSPHRASE", l2_hdrs.poly_passphrase}};

    auto post_start = std::chrono::high_resolution_clock::now();
    auto response = http.post("/orders", body_str, l2_headers);
    auto post_end = std::chrono::high_resolution_clock::now();
    auto post_duration = std::chrono::duration_cast<std::chrono::milliseconds>(post_end - post_start);

    std::cout << "    POST took: " << post_duration.count() << " ms\n";
    std::cout << "    Status: " << response.status_code << "\n";

    if (response.ok())
    {
        auto result = json::parse(response.body);
        std::cout << "\n[8] Results:\n";

        bool all_filled = true;
        for (size_t i = 0; i < result.size(); i++)
        {
            auto &r = result[i];
            std::string side = (i == 0) ? "YES" : "NO";
            bool success = r.value("success", false);
            std::string status = r.value("status", "unknown");
            std::string error_msg = r.value("errorMsg", "");
            std::string order_id = r.value("orderID", "");
            std::string taking = r.value("takingAmount", "0");
            std::string making = r.value("makingAmount", "0");

            std::cout << "    " << side << " order:\n";
            std::cout << "      Success: " << (success ? "YES" : "NO") << "\n";
            std::cout << "      Status:  " << status << "\n";
            if (!error_msg.empty())
                std::cout << "      Error:   " << error_msg << "\n";
            if (!order_id.empty())
                std::cout << "      OrderID: " << order_id << "\n";
            if (taking != "0")
                std::cout << "      Shares:  " << taking << "\n";
            if (making != "0")
                std::cout << "      USDC:    " << making << "\n";

            if (!success || (status != "MATCHED" && status != "matched"))
                all_filled = false;
        }

        if (all_filled)
            std::cout << "\n    BOTH ORDERS FILLED!\n";
        else
            std::cout << "\n    Not all orders filled\n";
    }
    else
    {
        std::cerr << "    Failed: " << response.body << "\n";
    }

    http_global_cleanup();
    return 0;
}
