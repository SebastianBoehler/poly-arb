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

# Options for advanced optimizations
option(ENABLE_LTO "Enable Link-Time Optimization (Release only)" ON)
option(ENABLE_PGO_GENERATE "Build with PGO instrumentation (profile generation)" OFF)
option(ENABLE_PGO_USE "Build using PGO profile data" OFF)
option(ENABLE_ASAN "Enable AddressSanitizer (Debug/RelWithDebInfo)" OFF)
option(ENABLE_UBSAN "Enable UndefinedBehaviorSanitizer (Debug/RelWithDebInfo)" OFF)
option(POLY_ARB_BUILD_TESTS "Build poly-arb C++ unit tests" ON)

# Compiler flags for performance
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -DNDEBUG")
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -DDEBUG")
set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "-O2 -g -march=native -DNDEBUG -fno-omit-frame-pointer")

# Link-Time Optimization (LTO) for Release builds
if(ENABLE_LTO AND CMAKE_BUILD_TYPE STREQUAL "Release")
    include(CheckIPOSupported)
    check_ipo_supported(RESULT lto_supported OUTPUT lto_error)
    if(lto_supported)
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)
        message(STATUS "LTO enabled for Release build")
    else()
        message(WARNING "LTO not supported: ${lto_error}")
    endif()
endif()

# Profile-Guided Optimization (PGO)
if(ENABLE_PGO_GENERATE)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fprofile-generate=${CMAKE_BINARY_DIR}/pgo-data")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fprofile-generate=${CMAKE_BINARY_DIR}/pgo-data")
    message(STATUS "PGO: Instrumentation enabled. Run workload, then rebuild with -DENABLE_PGO_USE=ON")
elseif(ENABLE_PGO_USE)
    if(EXISTS "${CMAKE_BINARY_DIR}/pgo-data")
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fprofile-use=${CMAKE_BINARY_DIR}/pgo-data -fprofile-correction")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fprofile-use=${CMAKE_BINARY_DIR}/pgo-data")
        message(STATUS "PGO: Using profile data from ${CMAKE_BINARY_DIR}/pgo-data")
    else()
        message(WARNING "PGO: Profile data not found at ${CMAKE_BINARY_DIR}/pgo-data. Run instrumented build first.")
    endif()
endif()

# Sanitizers for debugging (not for Release)
if(ENABLE_ASAN AND NOT CMAKE_BUILD_TYPE STREQUAL "Release")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=address -fno-omit-frame-pointer")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=address")
    message(STATUS "AddressSanitizer enabled")
endif()

if(ENABLE_UBSAN AND NOT CMAKE_BUILD_TYPE STREQUAL "Release")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=undefined")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=undefined")
    message(STATUS "UndefinedBehaviorSanitizer enabled")
endif()

# Fetch dependencies
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

if(NOT TARGET OpenSSL::SSL)
    add_library(OpenSSL::SSL UNKNOWN IMPORTED GLOBAL)
    set_target_properties(OpenSSL::SSL PROPERTIES
        IMPORTED_LOCATION "${OPENSSL_SSL_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${OPENSSL_INCLUDE_DIR}")
endif()

if(NOT TARGET OpenSSL::Crypto)
    add_library(OpenSSL::Crypto UNKNOWN IMPORTED GLOBAL)
    set_target_properties(OpenSSL::Crypto PROPERTIES
        IMPORTED_LOCATION "${OPENSSL_CRYPTO_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${OPENSSL_INCLUDE_DIR}")
endif()

include(FetchContent)

# Polymarket C++ Client library. Defaulting to main keeps execution code on
# the newest client; override POLYMARKET_CLIENT_GIT_TAG for reproducible builds.
set(POLYMARKET_CLIENT_GIT_TAG "main" CACHE STRING "Git ref for polymarket-cpp-client")
set(FETCHCONTENT_UPDATES_DISCONNECTED_POLYMARKET_CLIENT OFF CACHE BOOL
    "Always check for polymarket-cpp-client updates during configure" FORCE)
set(POLYMARKET_CLIENT_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(POLYMARKET_CLIENT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    polymarket_client
    GIT_REPOSITORY https://github.com/SebastianBoehler/polymarket-cpp-client.git
    GIT_TAG ${POLYMARKET_CLIENT_GIT_TAG}
    GIT_PROGRESS TRUE
)
FetchContent_MakeAvailable(polymarket_client)

# Strategy executables - all link against polymarket::client

add_library(polyarb_strategies
    src/discovery_options.cpp
    src/example_strategies.cpp
    src/slippage.cpp
)
target_include_directories(polyarb_strategies PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(polyarb_strategies PUBLIC polymarket::client)

add_executable(discovery_mode src/discovery_mode.cpp)
target_link_libraries(discovery_mode PRIVATE polyarb_strategies)

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

# Average-in strategy test executable
add_executable(avg_in_test src/avg_in_test.cpp)
target_link_libraries(avg_in_test PRIVATE polymarket::client)

# Install
install(TARGETS polymarket_arb DESTINATION bin)

if(POLY_ARB_BUILD_TESTS)
    enable_testing()

    add_executable(example_strategies_test tests/example_strategies_test.cpp)
    target_link_libraries(example_strategies_test PRIVATE polyarb_strategies)
    add_test(NAME example_strategies_test COMMAND example_strategies_test)
endif()
