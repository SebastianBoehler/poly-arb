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

# Fetch dependencies
include(FetchContent)

# Polymarket C++ Client library
set(POLYMARKET_CLIENT_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(POLYMARKET_CLIENT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    polymarket_client
    GIT_REPOSITORY https://github.com/SebastianBoehler/polymarket-cpp-client.git
    GIT_TAG main
)
FetchContent_MakeAvailable(polymarket_client)

# Strategy executables - all link against polymarket::client

# Main arbitrage bot
add_executable(polymarket_arb src/main.cpp)
target_link_libraries(polymarket_arb PRIVATE polymarket::client)

# Order signing test executable
add_executable(order_test src/order_test.cpp)
target_link_libraries(order_test PRIVATE polymarket::client)

# Arbitrage test executable (batch orders with WebSocket)
add_executable(arb_test src/arb_test.cpp)
target_link_libraries(arb_test PRIVATE polymarket::client)

# ClobClient test executable
add_executable(clob_client_test src/clob_client_test.cpp)
target_link_libraries(clob_client_test PRIVATE polymarket::client)

# Batch order smoke test executable
add_executable(batch_order_smoke src/batch_order_smoke.cpp)
target_link_libraries(batch_order_smoke PRIVATE polymarket::client)

# Ladder accumulation strategy executable
add_executable(ladder_accumulation src/ladder_accumulation.cpp)
target_link_libraries(ladder_accumulation PRIVATE polymarket::client)

# Position management smoke test executable
add_executable(position_smoke src/position_smoke.cpp)
target_link_libraries(position_smoke PRIVATE polymarket::client)

# Order placement benchmark executable
add_executable(order_benchmark src/order_benchmark.cpp)
target_link_libraries(order_benchmark PRIVATE polymarket::client)

# Install
install(TARGETS polymarket_arb DESTINATION bin)
