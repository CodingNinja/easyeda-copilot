# Per-pin connection styling — Phase 0 findings

Answers to the **[VERIFY]** items in `CLAUDE.md`. Static answers come from
`@jlceda/pro-api-types@0.2.30` (`node_modules/@jlceda/pro-api-types/index.d.ts`).
Runtime answers come from the `debug_dump_net_symbols` tool run against a scratch page
in EasyEDA Pro; raw outputs are pasted verbatim under each item.

## How the dump is produced

- Extension event `debug-dump-net-symbols` (`src/eda/connections.ts` → `dumpNetSymbols()`), read-only.
- MCP tool `debug_dump_net_symbols`, registered only when the MCP server runs with `EASYEDA_COPILOT_DEBUG=1`.
- Without restarting any MCP client, the same event can be sent through the running bridge:

  ```bash
  node mcp/scripts/easyeda-request.mjs proxy:list-easyeda-instances
  node mcp/scripts/easyeda-request.mjs debug-dump-net-symbols --instance <id> --out /tmp/dump.json
  ```

## Scratch page used

One resistor `R1`: pin 1 → wire → net label `SIG_A` (typed with **N**); pin 2 → wire → GND power flag.
One resistor `R2`: pin 1 → wire → net port `PORT_B`; pin 2 → wire carrying **both** a label `DUP` and a port `DUP`.

_Status (2026-09-09 10:45): scratch page drawn (Test Project, page P1); dump captured; label / direction model
corrected from it. Every `npm run build` now bumps the version, so each build installs as a new extension._

## Static findings (from the typings, 2026-09-09)

### [VERIFY B] Deleting a net label attribute — typings say it is impossible

`SCH_PrimitiveAttribute.create()` and `.delete()` are both documented as no-ops:

```
/** 创建属性  @internal  @remarks 属性图元不支持新建，本接口调用将不会有任何效果  @returns `undefined` */
create(): undefined;
/** 删除属性  @internal  @remarks 属性图元不支持删除，本接口调用将不会有任何效果  @returns `false` */
delete(): boolean;
```

(“Attribute primitives do not support creation / deletion; calling this has no effect.”)
There is **no** generic `sch_Primitive.delete()`; `SCH_Primitive` only exposes getters, `importChanges()`,
`save()` and navigation. `createNetLabel(x, y, net)` is a separate `@alpha` method on the same class.

**Decision (owner, 2026-09-09):** if the runtime confirms the label cannot be deleted, "remove label" is
implemented by deleting the wire primitive the label belongs to and recreating an identical wire with the
same net (the attribute dies with its parent). Hiding via `valueVisible:false` is not used.

### [VERIFY F] Net-port direction — no getter in the typings

`createNetPort(direction: 'IN' | 'OUT' | 'BI', …)` exists (lines 14747 / 15484) but no `getState_*`
returns the direction. Until the dump shows where it is stored (candidate: `getState_OtherProperty()`),
`include_connections` reports `direction: null` for ports. Runtime check still pending.

### Test runner

`node --test tests/` (as written in the plan) fails: Node needs a file glob, and the ES-module resolver
needs explicit extensions for source-to-source imports. Use `npm test`
(= `node --import ./tests/setup.mjs --test 'tests/*.test.ts'`); the tiny hook in `tests/resolve-ts.mjs`
retries extensionless relative imports as `.ts`.

### Pre-existing type errors

`npx tsc --noEmit` on the extension reports ~30 errors at `v1.1.9` that are unrelated to this work
(e.g. `mcp-client.ts` 961–1043, `ISCH_PrimitiveComponent$1` unions). The build uses esbuild and does
not type-check, so these were never blocking. New files (`connections*.ts`, `geometry.ts`) are clean.

## Runtime findings (scratch page, 2026-09-09, EasyEDA Pro 3.x desktop)

Dump of the scratch page (`debug-dump-net-symbols`, abridged; ids shortened):

```json
"components": [
  {"type":"netflag","net":"GND","x":620,"y":515,"rot":90,"pins":[{"number":"1","name":"Pin1","x":620,"y":515,"rot":180}]},
  {"type":"netport","net":"PORT_B","x":575,"y":480,"rot":0,"pins":[{"number":"1","name":"IN","x":575,"y":480}]},
  {"type":"netport","net":"DUP","x":635,"y":480,"rot":0,"pins":[{"number":"1","name":"OUT","x":635,"y":480,"rot":180}]},
  {"type":"part","designator":"R1","x":600,"y":515}, {"type":"part","designator":"R2","x":600,"y":480}
],
"wires": [
  {"id":"d247…","net":"SIG_A","line":[580,515,565,515]},   // R1.1: label typed with N
  {"id":"32e5…","net":"DUP",  "line":[620,480,635,480]},   // R2.2: label DUP + port DUP
  {"id":"744c…","net":"",     "line":[580,480,575,480]},   // R2.1: under the PORT_B port
  {"id":"72df…","net":"",     "line":[620,515,620,515]}    // R1.2: zero-length, GND flag dropped on the pin
],
"attributes": []                                           // sch_PrimitiveAttribute.getAll() with no parent → nothing
```

- **[VERIFY A] — answered.** A net label typed with **N** is **neither** a `netlabel` component nor an attribute
  primitive returned by `getAll()`. It exists only as the wire's own `net` value (`SIG_A`, `DUP`). The extension
  therefore treats "wire has a non-empty, non-`$` net" as "this wire carries a label", and reports the wire id as
  the label's `primitive_id`.
- **[VERIFY C] — answered.** No attribute key is involved. Wire under the label: `net === "SIG_A"`. Wire under the
  GND flag: `net === ""`. Wire under the `PORT_B` port: `net === ""`. So symbols do **not** write their name into the
  wire; the netlist derives the net from the symbol.
- **[VERIFY F] — answered.** Direction is not a getter, but the native port's single pin is named `IN` / `OUT`
  (`BI` expected for the third kind). `include_connections` maps these to `input` / `output` / `bidirectional`.
  The GND flag's pin is `Pin1`.
- **Flag dropped on a pin** creates a zero-length wire `[x,y,x,y]` at the pin. `include_connections` reports it
  (`wire_id` set, `wire_net: null`, one `flag`), and a restyle plans a 10-unit stub before moving the symbol.
- `include_connections` read-back of the page, first attempt (before the label model was fixed): `R1.1` showed
  `symbols: []` although the wire is named `SIG_A`; `R1.2` showed the GND flag; `R2.1` the `PORT_B` port; `R2.2`
  the `DUP` port only. After the fix `R1.1` and `R2.2` also report their `label`.
- **[VERIFY B] — answered.** `sch_PrimitiveWire.modify(id, { net: '' })` clears a label; the wire's `Name`
  attribute (seen via `sch_PrimitiveAttribute.getAll(wireId)`, key `"Name"`, `valueVisible: true`) becomes `""`.
  Reported as `label_removal: "wire_net_cleared"`. The wire-recreate fallback was never needed.
- **[VERIFY C] — refined.** `getAll(parentId)` does work per parent. Every wire has attributes `Relevance` and
  `Name`; `Name.value` is the net and `Name.valueVisible` is whether the label text shows.
- **[VERIFY D] — moot.** Wires never carry a symbol's name, so deleting a port or flag does not rename the wire.
- **[VERIFY E] — answered.** Creating a label on an existing wire works; the wire's `net` became the label name
  and the read-back reports `label:<name>`. Which call did it is recorded per item as `label_creation`
  (`createNetLabel` or `wire_net_set`).
- **[VERIFY G]** `removeComponent()` leftovers: _not tested_ (not needed by the implemented design).
- **[VERIFY H] — measured, visual check pending.** Hand-placed references: Netport (In) at a left wire end →
  component rotation 0, pin rotation 0; Netport (Out) at a right wire end → rotation 0, pin rotation 180; a GND
  flag dropped on a pin → rotation 90, pin rotation 180. Model: the symbol's pin must point back at the wire;
  base pin angle at rotation 0 is In 0°, Out/Bi 180°, Power flag 270°, ground flags 90°. Round two produced
  Out port at left end → 180, In port at left end → 0 (identical to the hand-placed one), ground flag at the end
  of a +x stub → 90 with pin 180 (identical to the hand-placed one).

### Live restyle runs (Test Project, page P1)

Round one (build 1.2.3) — all applied, every `before === after` net:
`R2.2 → label` removed the duplicate port; `R1.1 label → port(out)` (`wire_net_cleared`);
`R1.2 flag-on-pin → port(bi)` drew stub `[620,515,630,515]`; `R2.1 port(in) → flag`.
Defects found and fixed: the stub was created **with** the net name, which itself reads as a label
(fixed: stubs are unnamed); port rotation used the assembly "+90" rule and stood vertical on a horizontal
wire (fixed: measured pin-angle model above).

Round two (build 1.2.4, page reverted by hand first) — all applied, every net unchanged:
`R1.1 → port(out)` rot 180; `R2.1 → flag(Ground)` rot 270 then `→ port(in)` rot 0; `R2.2 → label`;
`R1.2 → port(bi)` with stub then `→ flag` rot 90. Dry run of four items changed nothing and returned the plans.
Not yet demonstrated on the live page: `NAME_MISMATCH` (needs a wire carrying two names, drawn by hand),
`WOULD_ORPHAN`, rollback.

### Scope

Owner decision (2026-09-09): scope changes (label ⇄ port/flag) are **reported, not blocked** —
`connectionRestyle.scope_changes` lists them for later review so bulk edits stay single-pass.

## Owner decisions recorded (2026-09-09)

| Question | Decision |
| --- | --- |
| Default `flag_kind` for nets containing `PGND` | `ProtectGround`; `GND` → `Ground`; otherwise `Power` |
| `restyle_connections` on a pin with no wire and no symbol | error `PIN_UNCONNECTED` |
| Label removal fallback if the API cannot delete attributes | recreate the wire stub |
| Debug tool | kept, behind `EASYEDA_COPILOT_DEBUG=1` |
| Version | bumped to `1.2.0` from the first spike build |
| Git | work on `main`, no commits by the assistant |
