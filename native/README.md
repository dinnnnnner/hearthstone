# Rust rules migration

**Status: incomplete. Do not select this core as a full game engine yet.**

The requested scope is Python training, online rooms, and browser practice, sharing one Rust rule implementation. This workspace implements individual rules and batched recruitment settlement, including a partial recruitment effect dispatcher. `Simulator`, `Rooms`, and the practice application still execute the production TypeScript engine. The runtime loaders added here are callable bindings, not completed application integration.

## Build and verify

Requirements: Rust with edition 2024 support, the `wasm32-unknown-unknown` target, Node dependencies from this repository, Python 3, and Playwright Chromium.

```sh
rustup target add wasm32-unknown-unknown
npm run build:rust
npm run test:rust
```

The test command builds the native library and WebAssembly module, checks formatting, runs Rust ownership/error tests and Clippy, generates reference results from the production TS implementation, then compares all fixtures through Python ctypes, Node WebAssembly, and headless Chromium. Generated reports and reference fixtures are in `native/target/parity/` and are ignored by Git.

The catalog export is build-time data generation. The Rust library does not execute JavaScript or delegate rules to a Node subprocess. Reference TS execution occurs only in the differential test suite.

## Components

- `rules`: shared Rust implementation and embedded catalog.
- `ffi`: C ABI compiled as a native shared library and browser-compatible Wasm.
- `../rl/python/tavern_rl/native_rules.py`: Python ctypes binding, independent of the existing Node training bridge.
- `../src/rules/rust-kernel.ts`: common Node/browser Wasm ownership and JSON protocol.
- `../server/rust-rules.ts`: Node filesystem loader.
- `../src/rules/rust-browser.ts`: browser asset loader.
- `data/catalog.json`: resolved card, hero, gift and trinket definitions, including related cards.
- `data/migration.json`: source effect/handler inventory and catalog fingerprint. Catalog coverage is not executable rule coverage.

Native calls use `{ "command": "...", ... }` requests and `{ "ok": true, "result": ... }` or `{ "ok": false, "error": "..." }` responses. The ABI allocates byte buffers with explicit ownership; its returned buffer contains a four-byte little-endian payload size followed by JSON. Hosts free both allocations with their exact lengths. Requests and responses are limited to 32 MiB. Browser bindings recreate views after calls that can grow linear memory.

## Verified operations

| Area | Operations | Scope |
| --- | --- | --- |
| Cards | `makeMinion`, `makeGolden`, `mergeTriple`, `copyAbility` | Creation, stat/counter/keyword inheritance. Automatic matching and hand-entry effects also run through `recruitBatch`; full action settlement remains pending. |
| Stats | `applyGlobal`, `syncStats` | Persistent counters, shop-independent global buffs, conditional stat changes. Combat retained links remain pending. |
| Costs | `prices` | Minion/spell purchase price, health payment eligibility, refresh payment. Spending side effects remain pending. |
| Pool | `assertPool`, `drawMinion` | Finite pool accounting and weighted minion draw, including global stats. |
| Gifts | `giftTierRange`, `eligibleGifts`, `attachDarkGift` | Turn/type restrictions and immediate attachment effects. Dark-gift discovery orchestration also runs through `recruitBatch`; gift event triggers remain pending. |
| Targets | `targets` | Battlecry, cast and activation target selection. |
| Hero powers | `powerState`, `nguyenPowerEligible`, `equipPowers` | Cost, limits, targets, unlocks, replacement and progress preservation. Power effects remain pending. |
| Trinkets | `canOfferTrinket`, `trinketCost`, `offerTrinkets` | Eligibility, tribe weights, offer compatibility, discounts, deterministic RNG. Purchase and ongoing effects remain pending. |
| Recruitment | `recruitBatch` | Discovery queues, automatic triples, hand overflow, reward handling, release, shop buffs, recruitment stat propagation and 37 effect families. Unsupported effects abort the request. |
| Combat prototype | `combatSubset` | Only the six audited cards documented in `../experiments/rust-combat/README.md`. |

## Recruitment batches

`recruitBatch` takes a season `state`, a uint32 `seed`, a nonnegative `uidCounter`, optional `recordLogs`, and an ordered `operations` array. It returns `state`, `rng`, `draws`, `uidCounter`, and one `results` value per operation. Generated instance IDs use `native-<counter>`. Preserve the returned state, RNG and counter together when continuing; `draws` counts only the current batch.

Implemented operations are `putHand`, `trinketCard`, `flushTrinketCards`, `triples`, `reward`, `releasePlayerCards`, `queueDiscovery`, `copyDiscovery`, `nextDiscovery`, `drawSpell`, `darkDiscover`, `gold`, `trinketGold`, `deityGain`, `applyShop`, `scale`, `gain`, `effect`, `runEvent`, and `triggerBattlecry`. These are internal settlement operations, not validated player actions. For example, the dark-gift player-action turn guard still belongs to the unfinished action dispatcher.

`effect` accepts an `ability` and either an owned source `uid` or a detached source `minion`; effects that change the source require an owned source. `target` and `eventMinion` refer to owned minion UIDs. This dispatcher currently handles recruitment contexts only; `combat: true` is rejected. See `meta.recruitEffects` for the supported operation families. An unknown family returns `RUST_EFFECT_INCOMPLETE`, without returning a partially changed game or calling TypeScript.

The reference suite compares complete batch outputs, including RNG consumption, instance IDs, logs, and queued cards. Rust tests additionally check finite-pool conservation, hand overflow after triples, first-gift inheritance, continuation across serialized batches, recursive trigger limits, and rejection of unsupported effects.

## Remaining work before activation

1. Complete recruitment action transitions, refresh/spending event orchestration, and the remaining effect dispatch paths.
2. Implement hero effects, gift triggers, deities, trinket events and full combat, including persistent combat gains.
3. Port classic rules used by existing callers, or explicitly agree on removal of that mode.
4. Implement eight-seat pool ownership, pairing and round settlement, legal actions, observations, rewards and snapshots.
5. Wire the actual training, room and practice entrypoints to the native core. Keep saved-state and model schema compatibility explicit.
6. Compare complete seeded games and snapshot/restore continuations across all three runtimes, then switch defaults.

`meta.fullEngineReady` is deliberately false. `reset`, `step`, `action`, `combat`, `restore`, and `snapshot` return `RUST_ENGINE_INCOMPLETE`. Both bindings provide a full-engine gate and refuse to claim successful activation. There is no silent TypeScript fallback inside this Rust core.

The earlier six-card combat benchmark is not a benchmark of this whole engine and does not establish a full-training speedup.
