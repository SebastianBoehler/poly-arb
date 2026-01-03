cmake_minimum_required(VERSION 3.16)

# Policy for older CMake compatibility in dependencies
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

project(polymarket_arb VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Build type
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Compiler flags for performance
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -DNDEBUG")
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -DDEBUG")

# Find required packages
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

# Fetch dependencies
include(FetchContent)

# nlohmann/json for JSON parsing
FetchContent_Declare(
    json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
)

# ixwebsocket - modern C++ WebSocket library (easier to build than libwebsockets)
FetchContent_Declare(
    ixwebsocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG v11.4.5
)

# secp256k1 for ECDSA signing
FetchContent_Declare(
    secp256k1
    GIT_REPOSITORY https://github.com/bitcoin-core/secp256k1.git
    GIT_TAG v0.4.1
)

# ethash for keccak256 hashing
FetchContent_Declare(
    ethash
    GIT_REPOSITORY https://github.com/chfast/ethash.git
    GIT_TAG v1.0.1
)

set(USE_TLS ON CACHE BOOL "" FORCE)
set(USE_OPEN_SSL ON CACHE BOOL "" FORCE)
set(SECP256K1_ENABLE_MODULE_RECOVERY ON CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_EXHAUSTIVE_TESTS OFF CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_BENCHMARK OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(json ixwebsocket secp256k1 ethash)

# Include directories
include_directories(
    ${CMAKE_SOURCE_DIR}/include
    ${CURL_INCLUDE_DIRS}
    ${OPENSSL_INCLUDE_DIR}
)

# Source files
set(SOURCES
    src/main.cpp
    src/http_client.cpp
    src/websocket_client.cpp
    src/market_fetcher.cpp
    src/orderbook.cpp
    src/order_signer.cpp
    src/clob_client.cpp
)

# Create executable
add_executable(polymarket_arb ${SOURCES})

# Link libraries
target_link_libraries(polymarket_arb
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    ixwebsocket
    secp256k1
    keccak
)

# Order signing test executable
add_executable(order_test src/order_test.cpp src/order_signer.cpp src/http_client.cpp)
target_link_libraries(order_test
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
)

# Arbitrage test executable (batch orders with WebSocket)
add_executable(arb_test src/arb_test.cpp src/order_signer.cpp src/http_client.cpp src/websocket_client.cpp)
target_link_libraries(arb_test
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    ixwebsocket
    secp256k1
    keccak
)

# ClobClient test executable
add_executable(clob_client_test src/clob_client_test.cpp src/clob_client.cpp src/order_signer.cpp src/http_client.cpp)
target_link_libraries(clob_client_test
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
)

# Batch order smoke test executable
add_executable(batch_order_smoke src/batch_order_smoke.cpp src/order_signer.cpp src/http_client.cpp)
target_link_libraries(batch_order_smoke
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
)

# Ladder accumulation strategy executable
add_executable(ladder_accumulation 
    src/ladder_accumulation.cpp 
    src/order_signer.cpp 
    src/http_client.cpp 
    src/websocket_client.cpp
)
target_link_libraries(ladder_accumulation
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
    ixwebsocket
)

# Position management smoke test executable
add_executable(position_smoke 
    src/position_smoke.cpp 
    src/clob_client.cpp
    src/order_signer.cpp 
    src/http_client.cpp
)
target_link_libraries(position_smoke
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
)

# Order placement benchmark executable
add_executable(order_benchmark 
    src/order_benchmark.cpp 
    src/order_signer.cpp 
    src/http_client.cpp
)
target_link_libraries(order_benchmark
    PRIVATE
    ${CURL_LIBRARIES}
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    nlohmann_json::nlohmann_json
    secp256k1
    keccak
)

# Install
install(TARGETS polymarket_arb DESTINATION bin)
