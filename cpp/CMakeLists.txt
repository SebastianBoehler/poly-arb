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

# Average-in strategy test executable
add_executable(avg_in_test src/avg_in_test.cpp)
target_link_libraries(avg_in_test PRIVATE polymarket::client)

# Install
install(TARGETS polymarket_arb DESTINATION bin)
