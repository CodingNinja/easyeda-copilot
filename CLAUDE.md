# EasyEDA Copilot fork — per-pin connection styling

**Implementation plan for a junior engineer.** Read the whole document before writing code. Every
file path, function name and API signature below was read from the real sources on 2026-09-09:
the upstream repository at tag `v1.1.9` (commit `3045ee5`) and the EasyEDA Pro API type package
`@jlceda/pro-api-types@0.2.30`. Where something could **not** be confirmed from those sources it is
marked **[VERIFY]** and Phase 0 tells you exactly how to verify it. Do not guess past a [VERIFY].

---

## 0. What we are building, and why

### The problem

When the extension draws a schematic connection it picks the symbol for you. A net whose name looks
like a rail (`GND`, `VCC…`, `V…`) gets a **power flag**; every other net gets a **net port**. The
rule lives in `src/eda/types.ts` (`shortSymbolsMap`) and `src/eda/place-net.ts`. A user who draws
their own sheets by hand uses **net labels** for signals. Mixing the two produces sheets where the
same net is drawn three different ways, and there is no tool to see or change which symbol a wire
carries. Today the only fix is manual clicking in the EasyEDA UI.

### The solution, in one sentence

Make the connection symbol a **per-pin attribute** that the caller can read, set when placing a
component, and change on an existing component, instead of a hidden name heuristic.

### The three deliverables

| #   | Name                  | Kind                                                                                                                                                      | One-line description                                                                                                                                      |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `include_connections` | new optional flag on the existing read tool `get_current_page_schematic`                                                                                  | For every pin, also report which symbol(s) name the wire touching it (`flag` / `port` / `label` / `wire`), so a caller can see mismatches and duplicates. |
| 2   | `connection_style`    | new optional field on every pin in `add_components` and on every entry of `external_connect` in the existing write tool `extract_circuit_on_current_page` | Lets the caller choose flag / port (with direction) / label / plain wire for that pin when the component is placed. Omitted = today's behaviour.          |
| 3   | `restyle_connections` | new optional list on the same write tool                                                                                                                  | For an **existing** component pin, change the symbol on its wire without changing the net. Refuses if the wire carries two different names.               |

### Non-goals

- No page-wide "normalize everything" tool. Callers iterate over pins using deliverable 1 + 3.
- No change to how the cloud service lays out new circuits (see §1.4 — we cannot change it anyway).
- No PCB work.
- No UI changes in the extension's iframe panels.

---

## 1. How the code base works today (read this before touching anything)

### 1.1 Two packages in one repository

```
easyeda-copilot/            ← the EasyEDA Pro EXTENSION (runs inside EasyEDA, has the `eda` API)
  src/index.ts              entry, registers menu functions from extension.json
  src/mcp-client.ts         WebSocket client to the local hub; big `if (message.event === '…')` dispatcher
  src/eda/*.ts              all EasyEDA API logic (schematic read, assembly, checkpoints, PCB…)
  packages/shared/types/    zod schemas shared by extension AND server (circuit.ts is the one we touch)
  extension.json            manifest; "version" must be bumped; "entry": "./dist/index"
  build.mjs, config/esbuild.prod.ts, build/packaged.ts   build chain → .eext
  tests/*.test.ts           node:test unit tests, import from ../src via .ts

  mcp/                      ← the MCP SERVER (runs under `npx easyeda-copilot-mcp`, talks to Claude)
    src/index.ts            registers tool groups
    src/tools/circuit.ts    `component_search`, `extract_circuit_on_current_page`, `beautify…`, `get_current_page_schematic`
    src/bridge/index.ts     `bridge.requestEasyEda(event, body, timeoutMs)` → sends {event, body:JSON} over the hub socket
    src/utils/server.ts     `postJson(path, payload)` → the author's CLOUD service (see 1.4)
    tsup.config.ts          builds dist/index.js
```

### 1.2 Message flow for a read

```
Claude → MCP tool get_current_page_schematic (mcp/src/tools/circuit.ts ~line 231)
      → bridge.requestEasyEda('get-schematic')
      → extension src/mcp-client.ts: `if (message.event === 'get-schematic')` (~line 1361)
      → src/eda/schematic.ts getSchematic(primitiveIds, {disableExtractPos:true})
      → reply(true, schematic)   // ExplainCircuit: { components:[{designator, value, part_uuid, pins:[{pin_number,name,signal_name}]}] }
```

`getSchematic()` (schematic.ts line 131) gets pin→net by **exporting EasyEDA's Allegro netlist**
(`eda.sch_ManufactureData.getNetlistFile(undefined, ESYS_NetlistType.ALLEGRO)`), parsing it
(`parseAllegroNetlist`, line 55), and keeping only nets whose names appear on the current page as a
wire net (`eda.sch_PrimitiveWire.getAll()…getState_Net()`) or as a NET_FLAG / NET_PORT component
(`eda.sch_PrimitiveComponent.getAll()` filtered by `getState_ComponentType()`, lines 154–170). It
then iterates components and their pins (`eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId`, line
229) and emits `signal_name` per pin. **This is where deliverable 1 hooks in.**

`getAsmCircuit()` (line 350) already demonstrates the geometry technique we need: it builds a
`pinCoordMap` keyed `"x,y"` (rounded with `to2()` from utils.ts) for every pin, reads every wire's
segments (`normalizeWireLine(wire.getState_Line())`), and treats a flag/port component as a
one-pin component positioned at `getState_X()/getState_Y()`. Copy that approach; do not invent a new
one.

### 1.3 Message flow for a write

```
Claude → MCP tool extract_circuit_on_current_page (circuit.ts ~line 104), input validated by CircuitModStruct()
      → bridge.requestEasyEda('get-schematic')                       // current page as ExplainCircuit
      → postJson('/v1/mcp-tools/extract-circuit', {circuit, inputCircuit})   // CLOUD: returns a CircuitAssembly (positions, edges)
      → bridge.requestEasyEda('assemble-circuit', result, 300000)
      → extension mcp-client.ts `if (message.event === 'assemble-circuit')` (~line 1784)
           checkpointer.save(false)  → assembleCircuit(circuit)  → estimateSchematicSheetSpace()
      → reply(true, {assembled:true, sheetSpace})
```

`assembleCircuit` lives in `src/eda/assemble.ts`; `createComponent()` (line ~28) places parts and,
for pseudo-components with `part_uuid === 'GND'` / `'VCC'`, places the flag symbols from
`src/eda/types.ts` (`GND_PORT_COMPONENT`, `VCC_PORT_COMPONENT`, `NET_PORT_COMPONENT`).
`src/eda/place-net.ts` draws wires from pins and decides whether a pin needs a new net symbol
(line ~296: it looks for existing NET_FLAG/NET_PORT components with the same net). Native symbol
creation is in `src/eda/assemble-source.ts createSeedComponent()` (line ~208):
`eda.sch_PrimitiveComponent.createNetFlag(kind, net, x, y, rotation, mirror)` and
`eda.sch_PrimitiveComponent.createNetPort('BI', net, x, y, rotation, mirror)`. Note ports are
always created **'BI'** today — direction is never set.

Component removal is `src/eda/rm-compoment-with-connections.ts removeComponent(designator, circuit)`
(line 503); `rmWireFromComponentPin(designator, pinNumber, net)` (line 494) removes the wire stub
from a pin. **[VERIFY]** whether a flag/port sitting on that stub is removed too — this session's
experience (parts replaced over the bridge) suggests symbols and stubs can be left behind. Phase 0
checks it.

### 1.4 The cloud dependency — the constraint that shapes the design

`extract_circuit_on_current_page` does **not** compute placement locally. It POSTs the request to the
author's server (`mcp/src/utils/server.ts`: `apiUrl = 'https://circuit.tech.ru.net'`, overridable
with env `EASYEDA_COPILOT_SERVER_URL`, fixed Basic auth header) and gets back a `CircuitAssembly`
with coordinates and edges. We cannot change that service, and we cannot assume it echoes fields it
does not know.

**Consequence for deliverable 2:** do not try to carry `connection_style` *through* the cloud call.
Strip it out of the circuit before `postJson`, keep it in a side map in the MCP server, and send it to
the extension **alongside** the assembly in the `assemble-circuit` body as a second field
(`connectionStyles`). The extension applies it as a post-pass after `assembleCircuit()` finishes,
using the same code path as deliverable 3. This keeps the cloud contract untouched and gives one
implementation of "make this pin's wire carry symbol X" that both write paths share.

### 1.5 Checkpoints already exist — use them

`src/eda/checkpointer.ts` and the events `checkpoint-save` / `checkpoint-restore` / `checkpoint-list`
(mcp tools `save_checkpoint_for_current_page`, `restore_checkpoint_for_current_page`,
`list_checkpoints`). `assemble-circuit` already calls `checkpointer.save(false)` before mutating.
Every mutating path you add must do the same.

---

## 2. EasyEDA Pro API facts you will use (from `@jlceda/pro-api-types@0.2.30`, `index.d.ts`)

Install the types locally to read them yourself: `npm pack @jlceda/pro-api-types@0.2.30`, untar,
open `package/index.d.ts` (20,218 lines). Line numbers below are from that file.

### 2.1 Components, including flags and ports (they ARE components)

```ts
// class SCH_PrimitiveComponent (line ~15440), reached as eda.sch_PrimitiveComponent
createNetFlag(identification: 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround',
              net: string, x: number, y: number, rotation?: number, mirror?: boolean): Promise<ISCH_PrimitiveComponent | undefined>;   // line 15471
createNetPort(direction: 'IN' | 'OUT' | 'BI',
              net: string, x: number, y: number, rotation?: number, mirror?: boolean): Promise<ISCH_PrimitiveComponent | undefined>;   // line 15484
delete(primitiveIds: string | ISCH_PrimitiveComponent | Array<string> | Array<ISCH_PrimitiveComponent>): Promise<boolean>;
getAll(): Promise<Array<ISCH_PrimitiveComponent>>;
getAllPrimitiveId(): Promise<Array<string>>;
getAllPinsByPrimitiveId(primitiveId: string): Promise<Array<ISCH_PrimitivePin>>;   // used in schematic.ts line 229

// instance getters (ISCH_PrimitiveComponent)
getState_PrimitiveId(): string;
getState_ComponentType(): ESCH_PrimitiveComponentType;   // line 15781
getState_Net(): string | undefined;                       // line 15052 — set on NET_FLAG / NET_PORT
getState_OtherProperty(): Record<string, unknown> | undefined;  // ['Global Net Name'] fallback used by upstream
getState_X(): number; getState_Y(): number; getState_Rotation(): number; getState_Mirror(): boolean;
getState_Designator(): string;   // '' for flags/ports — this is why today's read skips them

enum ESCH_PrimitiveComponentType {          // line 15318
  COMPONENT = "part", DRAWING = "sheet", NET_FLAG = "netflag", NET_PORT = "netport",
  NON_ELECTRICAL_FLAG = "nonElectrical_symbol", SHORT_CIRCUIT_FLAG = "short_symbol",
  NET_LABEL = "netlabel", OFF_PAGE_CONNECTOR = "offPageConnector",
  DIFFERENTIAL_PAIRS_FLAG = "diffPairsFlag", CBB_SYMBOL = "block_symbol"
}
```

`NET_LABEL = "netlabel"` is in the component-type enum. **[VERIFY A]** whether a net label placed by a
user in the UI shows up in `eda.sch_PrimitiveComponent.getAll()` with that type, or only as an
attribute (§2.3). Phase 0 answers this.

### 2.2 Wires

```ts
// class SCH_PrimitiveWire (line 17073), reached as eda.sch_PrimitiveWire
create(line: number[] | number[][], net?: string, color?: string|null, lineWidth?: number|null, lineType?: ESCH_PrimitiveLineType|null): Promise<ISCH_PrimitiveWire | undefined>;
delete(primitiveIds: string | ISCH_PrimitiveWire | Array<string> | Array<ISCH_PrimitiveWire>): Promise<boolean>;
modify(primitiveId: string | ISCH_PrimitiveWire, property: { line?; net?: string; color?; lineWidth?; lineType? }): Promise<ISCH_PrimitiveWire | undefined>;
get(primitiveId: string): Promise<ISCH_PrimitiveWire | undefined>;
getAll(net?: string | string[]): Promise<Array<ISCH_PrimitiveWire>>;
getAllPrimitiveId(net?: string | string[]): Promise<Array<string>>;

// instance
getState_PrimitiveId(): string; getState_Line(): number[] | number[][]; getState_Net(): string;
```

A wire's `net` is the name EasyEDA assigns to it. When a user presses **N** and types a name on a
wire, EasyEDA sets that wire's `net` and shows it as text. **Important nuance from upstream's own
release note for 1.1.9:** flags and ports can name a net *without* any wire carrying that net
attribute ("names absent from wire attributes"). So `wire.getState_Net()` is *one* source of a
wire's name, not the only one.

`getState_Line()` comes back either flat `[x1,y1,x2,y2,…]` or nested `[[x1,y1,x2,y2],…]`; always pass
it through `normalizeWireLine()` from `src/eda/utils.ts` (line 149). Coordinates must be compared
after `to2()` rounding (utils.ts line 3) — never with raw `===`.

Upstream wraps wire calls in `src/eda/wire-snap.ts` (`sch_PrimitiveWireSnap`) during assembly
because `getAll()` reads an asynchronous index that can lag by seconds. For our read path use plain
`eda.sch_PrimitiveWire.getAll()`; for our write path use `sch_PrimitiveWireSnap` exactly as
`place-net.ts` does, so newly created wires are visible to later steps in the same call.

### 2.3 Attributes — this is what a net label is

```ts
// class SCH_PrimitiveAttribute (line 13128), reached as eda.sch_PrimitiveAttribute
createNetLabel(x: number, y: number, net: string): Promise<ISCH_PrimitiveAttribute | undefined>;   // line 13214, marked @alpha
getAll(parentPrimitiveId?: string): Promise<Array<ISCH_PrimitiveAttribute>>;   // no arg = every attribute on the page
getAllPrimitiveId(parentPrimitiveId?: string): Promise<Array<string>>;
get(primitiveId: string): Promise<ISCH_PrimitiveAttribute | undefined>;
modify(primitiveId, property: { x?, y?, rotation?, color?, fontName?, fontSize?, bold?, italic?, underLine?, alignMode?, fillColor?, key?: string; value?: string; keyVisible?: boolean|null; valueVisible?: boolean|null }): Promise<ISCH_PrimitiveAttribute | undefined>;
delete(): boolean;      // ← declared with NO parameters in the typings. Almost certainly a typings bug. [VERIFY B]

// instance getters (ISCH_PrimitiveAttribute)
getState_PrimitiveId(): string; getState_Key(): string; getState_Value(): string;
getState_KeyVisible(): boolean|null; getState_ValueVisible(): boolean|null;
getState_ParentPrimitiveId(): string;     // ← the wire (or component) this attribute belongs to
getState_X(): number|null; getState_Y(): number|null;
```

So a **net label is an attribute primitive whose parent is a wire**. Its `getState_Key()` is some
fixed key string and `getState_Value()` is the net name. **[VERIFY C]** the exact key string (likely
`"Net"`, but read it, don't assume). **[VERIFY B]** how to delete one: try, in order,
`eda.sch_PrimitiveAttribute.delete(primitiveId)` despite the typings; if that throws or returns
false, try the generic `eda.sch_Primitive.delete(primitiveId)` if it exists; last resort
`modify(id, { valueVisible: false })` which hides it without removing it (acceptable fallback for
"remove label" only if nothing else works — document which one you ended up with).

### 2.4 Pins

From `getAllPinsByPrimitiveId(componentPrimitiveId)` each `ISCH_PrimitivePin` has
`getState_PinNumber()`, `getState_PinName()`, `getState_X()`, `getState_Y()`, `getState_Rotation()`
(all used in schematic.ts and place-net.ts). Pin X/Y is the **connection point**.

### 2.5 Logging and UI feedback

`eda.sys_Log.add(text, ESYS_LogType.INFO|WARNING|FATAL_ERROR)` writes to EasyEDA's log panel — use it
liberally; it is the only debugger you have inside the extension.
`eda.sys_Message.showToastMessage(text, ESYS_ToastMessageType.INFO|ERROR)` shows a toast.

---

## 3. Phase 0 — spike: verify the three unknowns (½ day)

Do this **before** designing data structures. Work on a scratch schematic in EasyEDA Pro (not the
user's project). Create a page with: one resistor, one wire from pin 1 with a **net label** `SIG_A`
typed via **N**; one wire from pin 2 with a **GND power flag**; a second resistor with a **net port**
named `PORT_B` on pin 1 and a wire with **both** a label `DUP` and a port `DUP` on pin 2.

Add a temporary event handler in `src/mcp-client.ts` (copy the shape of `'get-schematic'`):

```ts
if (message.event === 'debug-dump-net-symbols') {
    const comps = await eda.sch_PrimitiveComponent.getAll();
    const wires = await eda.sch_PrimitiveWire.getAll();
    const attrs = await eda.sch_PrimitiveAttribute.getAll();
    reply(true, {
        components: comps.map(c => ({ id: c.getState_PrimitiveId(), type: c.getState_ComponentType(), designator: c.getState_Designator(), net: c.getState_Net(), other: c.getState_OtherProperty(), x: c.getState_X(), y: c.getState_Y(), rot: c.getState_Rotation() })),
        wires: wires.map(w => ({ id: w.getState_PrimitiveId(), net: w.getState_Net(), line: w.getState_Line() })),
        attributes: attrs.map(a => ({ id: a.getState_PrimitiveId(), parent: a.getState_ParentPrimitiveId(), key: a.getState_Key(), value: a.getState_Value(), keyVisible: a.getState_KeyVisible(), valueVisible: a.getState_ValueVisible(), x: a.getState_X(), y: a.getState_Y() })),
    });
    return;
}
```

Expose it as a temporary MCP tool `debug_dump_net_symbols` in `mcp/src/tools/circuit.ts` (copy
`get_current_page_schematic`, change the event name). Build and install (§9). Call it. Record the
answers in `docs/extension-plan-findings.md`:

- **[VERIFY A]** Does the `SIG_A` label appear in `components` with `type === "netlabel"`, in
  `attributes` with `parent === <wire id>`, or both? Which one carries the name?
- **[VERIFY C]** What is `key` for the label attribute? Does the wire under it report
  `net === "SIG_A"`? Does the wire under the **GND flag** (no label) report `net === "GND"` or `""`?
  Does the wire under the **port** report `net === "PORT_B"` or `""`?
- **[VERIFY B]** Try deleting the `DUP` label: `eda.sch_PrimitiveAttribute.delete(id)`; then check
  whether the wire's `net` is still `DUP` (the port should still name it). Record what worked.
- **[VERIFY D]** Delete the `PORT_B` port with `eda.sch_PrimitiveComponent.delete(id)`. Does the
  wire keep `net === "PORT_B"` or become unnamed (EasyEDA auto-name starting with `$`)? This decides
  whether "remove port, add label" must add the label **first** (it must, if the wire loses its
  name — assume yes until proven otherwise).
- **[VERIFY E]** Create a label with `eda.sch_PrimitiveAttribute.createNetLabel(x, y, "SIG_C")` at
  the free end of a wire. Does the wire's `net` become `SIG_C`? Does it need to sit exactly on the
  wire end (`to2` equal) or anywhere on the segment? Does it show in `get-schematic` afterwards?
- **[VERIFY F]** Create a port with `createNetPort('OUT', …)`: confirm the direction is visible
  (which getter? probably `getState_OtherProperty()` or a dedicated getter — search `index.d.ts` for
  `Direction`). If direction cannot be read back, deliverable 1 reports direction as `null`.
- **[VERIFY G]** Remove a component with `removeComponent()` (rm-compoment-with-connections.ts) whose
  pin had a stub + flag: are the stub wire and the flag deleted or left behind?

Remove the debug tool before the final PR, or keep it behind an env flag `EASYEDA_COPILOT_DEBUG=1`.

---

## 4. Phase 1 — deliverable 1: `include_connections` on the read (1 day)

### 4.1 Schema change (`packages/shared/types/circuit.ts`)

Add, next to `PinSchema()`:

```ts
export const ConnectionSymbolSchema = () => z.object({
    type: z.enum(['flag', 'port', 'label']).describe('Kind of naming symbol found on the wire that touches this pin.'),
    name: z.string().describe('Net name the symbol carries.'),
    direction: z.enum(['input', 'output', 'bidirectional']).nullable().optional().describe('Ports only; null if EasyEDA does not expose it.'),
    primitive_id: z.string().describe('EasyEDA primitive id of the symbol, for restyle_connections.'),
});

export const PinConnectionSchema = () => z.object({
    wire_id: z.string().nullable().describe('Primitive id of the wire touching the pin; null if the pin has no wire.'),
    wire_net: z.string().nullable().describe('The wire\'s own net attribute as EasyEDA reports it; may be an auto-name starting with "$".'),
    symbols: z.array(ConnectionSymbolSchema()).describe('Every naming symbol on that wire. Empty = plain wire to another pin, or unnamed stub.'),
});

export const PinWithConnectionSchema = () => PinSchema().extend({
    connection: PinConnectionSchema().optional(),
});
```

Extend `ExplainCircuitStruct()` (find it in the same file) so `pins` accepts
`PinWithConnectionSchema()`. Because `connection` is optional, existing output still validates.

### 4.2 MCP server (`mcp/src/tools/circuit.ts`, tool `get_current_page_schematic`)

Change `inputSchema: z.object({})` to
`z.object({ include_connections: z.boolean().optional().default(false).describe('Also report the naming symbols (flag/port/label) on the wire at each pin.') })`
and pass it through: `bridge.requestEasyEda('get-schematic', { includeConnections: include_connections })`.
Keep the existing >40-components-to-file behaviour; it must also apply when connections are
included (the payload gets much bigger).

Update the tool `description` to mention the flag and what `connection.symbols` means.

### 4.3 Extension (`src/mcp-client.ts` + new `src/eda/connections.ts`)

In the `'get-schematic'` handler read `body.includeConnections`. When true, after `getSchematic()`
returns, call a new function `annotateConnections(schematic)` from `src/eda/connections.ts` and reply
with its result.

`annotateConnections` algorithm (write it as pure functions over plain data so it is unit-testable;
fetch from `eda` only at the top):

1. **Collect.** `comps = await eda.sch_PrimitiveComponent.getAll()`, `wires = await eda.sch_PrimitiveWire.getAll()`, `attrs = await eda.sch_PrimitiveAttribute.getAll()`.
2. **Index symbols.** Build `symbolsAt: Map<"x,y", Symbol[]>` for NET_FLAG and NET_PORT components at `to2(x),to2(y)`; `Symbol = {type:'flag'|'port', name, primitive_id, direction}`. Name = `getState_Net() || getState_OtherProperty()?.['Global Net Name']` (copy upstream's expression). Direction per **[VERIFY F]**.
3. **Index labels.** From `attrs`, keep those whose key matches **[VERIFY C]**; build `labelsByWire: Map<wireId, Symbol[]>` with `type:'label'`, `name = getState_Value()`, using `getState_ParentPrimitiveId()`. If **[VERIFY A]** showed labels are also components of type `netlabel`, index them by coordinate like flags instead and unify.
4. **Index wires.** For each wire, `segments = normalizeWireLine(getState_Line())`. Build `wireEndpoints: Map<"x,y", wireId[]>` for every segment end, and keep `wireById`.
5. **Per pin.** For each component in `schematic.components`, find its primitive (schematic.ts already has `searchComponentInSCH(designator)` in `src/eda/search.ts`), get pins via `getAllPinsByPrimitiveId`, and for each pin at `p = to2(x),to2(y)`:
   - `wireIds = wireEndpoints.get(p)` — also accept a pin that lands **on** a segment interior using `isPointOnSegment` from `rm-compoment-with-connections.ts` (exported, line 37). If none → `connection = { wire_id:null, wire_net:null, symbols:[] }`.
   - Take the first wire (log a WARNING if more than one). `wire_net = wire.getState_Net() || null`.
   - **Walk the connected wire cluster.** A pin's wire may be several wire primitives joined end to end. Do a BFS: start with the pin's wire, repeatedly add any wire sharing an endpoint. Collect the cluster's endpoint set.
   - `symbols = labelsByWire[every wire in cluster] ∪ symbolsAt[every endpoint in cluster]`.
   - Attach `connection` to the pin object.
6. Return the schematic.

Edge cases to handle explicitly and test:
- Flag placed **directly on a pin** with no wire (the 1.1.8 bug case): `wire_id:null` but `symbols` must still contain the flag → also look up `symbolsAt[p]` when no wire is found.
- Two different names on one cluster → both appear in `symbols`; that is the whole point, do not dedupe by name. Do dedupe by `primitive_id`.
- A wire cluster touching two pins of the same component (rare) → same symbols on both pins; fine.

### 4.4 Tests (`tests/connections.test.ts`, node:test like the existing tests)

Feed hand-written `comps/wires/attrs` plain objects into the pure functions and assert:
label-only wire → `[label]`; flag-on-stub → `[flag]`; flag+label same name → both; flag+label
different names → both with different names; flag directly on pin, no wire → `[flag]`, `wire_id
null`; two-segment cluster with the label on the far segment → found; nested vs flat `line` arrays.

### 4.5 Acceptance for Phase 1

Run against the CruiserCtrl project Sheet 02 (owner supplies it) with `include_connections:true`.
Expected: `R_TIE.1` shows a `GND` flag, `R_TIE.2` shows a `PGND` flag, every `TPn` shows exactly one
symbol, and nothing on the page is reported with two different names. Show the owner the raw JSON.

---

## 5. Phase 2 — deliverable 3 first: `restyle_connections` (2 days)

Do this **before** deliverable 2, because deliverable 2 is implemented as "place as today, then
restyle". Build the primitive once.

### 5.1 Schema (`packages/shared/types/circuit.ts`)

```ts
export const ConnectionStyleSchema = () => z.object({
    symbol: z.enum(['flag', 'port', 'label', 'wire']).describe(
        'flag = power flag (GND/rail symbol); port = net port; label = text net label on the wire; wire = no naming symbol (only valid when the pin is joined by a wire to another pin on the same net on this page).'),
    direction: z.enum(['input', 'output', 'bidirectional']).optional().describe('Ports only. Default bidirectional.'),
    flag_kind: z.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround']).optional().describe('Flags only. Default: Ground if the net name contains GND, else Power.'),
});

export const RestyleConnectionSchema = () => z.object({
    designator: z.string(),
    pin_number: z.union([z.number(), z.string()]),
    style: ConnectionStyleSchema(),
});
```

Add to `CircuitModStruct()` (the input schema of `extract_circuit_on_current_page`):
`restyle_connections: z.array(RestyleConnectionSchema()).nullable().optional()`.
Also add `dry_run: z.boolean().optional().default(false)` at the top level of `CircuitModStruct()`.

### 5.2 MCP server

In the `extract_circuit_on_current_page` handler: pull `restyle_connections` and `dry_run` off the
input **before** anything is sent to the cloud (the cloud must never see them). If the call has
**only** `restyle_connections` (no add/rm/external changes) skip the cloud and `assemble-circuit`
entirely and call a new event `restyle-connections` with `{ items, dryRun }`. If it has both, run
the existing flow first, then the restyle event. Return both results in one `textResult`.

### 5.3 Extension: new event `restyle-connections` (`src/mcp-client.ts` → `src/eda/connections.ts`)

Handler skeleton:

```ts
if (message.event === 'restyle-connections') {
    const items = body.items as RestyleItem[]; const dryRun = !!body.dryRun;
    if (!dryRun) await checkpointer.save(false);
    const report = await restyleConnections(items, { dryRun });
    reply(true, report);
    return;
}
```

`restyleConnections(items, {dryRun})` returns
`{ applied: [...], skipped: [{item, reason}], errors: [{item, error}], before: {designator.pin: net}, after: {designator.pin: net} }`.

Per item, in this order (stop the item and record a `skipped`/`error` entry at the first failure;
never continue on a half-done item):

1. **Locate the pin.** `searchComponentInSCH(designator)` → primitive; `getAllPinsByPrimitiveId` → pin with matching `pin_number`. Not found → error.
2. **Read the current state** using the Phase-1 collector: wire cluster, `wire_net`, `symbols`, and the pin's **net as EasyEDA sees it** (call `getSchematic([primitiveId])` and read `signal_name`; this is the authoritative "before" value). Record `before`.
3. **Refuse on mismatch.** If `symbols` contain two *different* names, or a symbol name differs from the pin's `signal_name` → `skipped` with reason `NAME_MISMATCH` listing both names. This is deliberate: a merged net is a human's problem.
4. **Refuse `wire` style if unsafe.** If `style.symbol === 'wire'` and, after removing every symbol, the net would have no other naming symbol on the page and the pin's wire cluster does not reach another pin → `skipped` with `WOULD_ORPHAN`. (Check: does any *other* component pin on the page report the same `signal_name`? Use the full `getSchematic()` result.)
5. **Plan.** `toDelete = symbols` (all of them). `toCreate = one symbol of the requested type`, positioned at the **free end** of the pin's wire cluster (an endpoint that is not a pin and not shared by another wire). If the pin has **no wire**, plan a stub: create a 10-unit wire from the pin in the pin's outward direction (use `pin.getState_Rotation()` and the direction table at the top of `place-net.ts`: 0→+x, 90→+y, 180→−x, 270→−y, then `normWireY` as place-net does) and put the symbol on its far end. If `dryRun`, push the plan to `applied` with `dry_run:true` and continue to the next item.
6. **Create first, delete second.** Order matters because of **[VERIFY D]**: a wire may lose its name when its only symbol is deleted, and EasyEDA may then merge or auto-name it. So:
   - create the new symbol with the **same net name**:
     - `flag` → `eda.sch_PrimitiveComponent.createNetFlag(kind, net, x, y, rotation)`; kind from `style.flag_kind` or the default rule; rotation: flags point up for Power, down for Ground — copy the rotation logic from `assemble-source.ts createSeedComponent()`/`getComponentRotation()`.
     - `port` → `createNetPort(dir, net, x, y, rotation)` with `dir` mapped `input→'IN'`, `output→'OUT'`, else `'BI'`.
     - `label` → `eda.sch_PrimitiveAttribute.createNetLabel(x, y, net)` per **[VERIFY E]**.
     - `wire` → create nothing.
   - if creation returned `undefined` → error, delete nothing.
   - then delete every entry in `toDelete` **except** one that is already exactly the requested type and name (keep it, don't churn). Components via `eda.sch_PrimitiveComponent.delete(id)`, labels via the method **[VERIFY B]** settled on.
7. **Verify.** Re-run `getSchematic([primitiveId])`; the pin's `signal_name` must equal `before`. If it does not: log FATAL, attempt to undo by re-creating what was deleted (you have their type/name/x/y), and record an `error` with `ROLLED_BACK` or `ROLLBACK_FAILED`. The caller will restore the checkpoint on `ROLLBACK_FAILED`.
8. Record `after`.

Wrap the whole loop with `sch_PrimitiveWireSnap.begin()/end()` (see how `assemble.ts` activates it)
so wire creations are visible to later items in the same call.

### 5.4 Tests

Pure-function tests for: plan generation (free-end selection, stub geometry for the four rotations),
the mismatch refusal, the would-orphan refusal, and the keep-existing-correct-symbol rule. The
`eda` calls are behind a small interface (`EdaConnectionsPort`) so tests inject a fake.

### 5.5 Acceptance for Phase 2

On the scratch page from Phase 0: `restyle` `R1.1` from label to port `output` → read-back shows one
`port` named `SIG_A`, direction `output`, `signal_name` unchanged. Restyle `R2.2` (`DUP` label +
port) to `label` → one label remains, port gone, net unchanged. Attempt to restyle a pin whose wire
carries `GND` flag and `AGND` label → `skipped: NAME_MISMATCH`, nothing changed. `dry_run:true`
changes nothing and reports the plan.

Then on CruiserCtrl Sheet 02 (checkpoint first): restyle `R_SLEEP.1` and `R_SLEEP.2` to `flag` and
read back; pin nets unchanged.

---

## 6. Phase 3 — deliverable 2: `connection_style` on placement (1 day)

### 6.1 Schema

Add to `PinSchema()` in `packages/shared/types/circuit.ts`:
`connection_style: ConnectionStyleSchema().optional().describe('How to draw this pin\'s connection when the component is placed. Omit for the default (rail names → flag, others → port).')`
and to each `external_connect` entry the same optional field.

### 6.2 MCP server

In `extract_circuit_on_current_page`: before `postJson(...)`, walk `circuit.add_components[*].pins`
and `circuit.external_connect[*]`, copy any `connection_style` into
`connectionStyles[designator][String(pin_number)] = style`, and **delete the field from the object
sent to the cloud** (deep-clone first; do not mutate the validated input). After the cloud returns,
send `bridge.requestEasyEda('assemble-circuit', { ...result, connectionStyles }, 300000)`.

### 6.3 Extension

In the `'assemble-circuit'` handler, after `await assembleCircuit(circuit)`, if
`body.connectionStyles` is non-empty, convert it to `RestyleItem[]` and call
`restyleConnections(items, { dryRun:false })` from Phase 2. Include its report in the reply as
`connectionRestyle`. Do **not** take a second checkpoint (the assemble handler already saved one).

That is the whole of deliverable 2. No change to placement, wiring or the cloud contract.

### 6.4 Acceptance

Add a resistor with pin 1 `{signal_name:"GND", connection_style:{symbol:"label"}}` and pin 2
`{signal_name:"SIG_X", connection_style:{symbol:"port", direction:"input"}}`. Read back with
`include_connections`: pin 1 has exactly one `label` `GND`; pin 2 exactly one `port` `SIG_X`
`input`. Add the same resistor **without** `connection_style` → today's behaviour (flag on GND, port
on SIG_X) is unchanged.

---

## 7. Documentation you must update in the same PR

- `mcp/docs/schematic/circuit-mod.md`: new section "Connection symbols" explaining the three
  styles, the default rule, `restyle_connections`, `dry_run`, and the `NAME_MISMATCH` /
  `WOULD_ORPHAN` refusals. Use the Phase 0 findings file for the exact behaviours.
- `mcp/docs/SKILL.md`: one line under "Create, modify, or beautify a schematic" pointing to the
  new section, and the rule "read with `include_connections` before `restyle_connections`".
- The tool `description` strings in `mcp/src/tools/circuit.ts` (they are what the LLM reads).
- `CHANGELOG.md` entry; bump `extension.json` `"version"`, root `package.json`, `mcp/package.json`
  to `1.2.0` (same number in all three — the installer treats an identical version as "already
  installed").
- `docs/extension-plan-findings.md` (new): the Phase 0 answers, verbatim outputs included.

---

## 8. Coding rules for this repo

- TypeScript strict; run `npm run eslint` in the root before committing (prettier + eslint via
  lint-staged is configured).
- Never compare coordinates without `to2()`; never read `getState_Line()` without
  `normalizeWireLine()`.
- Every `eda.*` call that can return `undefined` is checked; every promise that can reject is
  `.catch`-ed with an `eda.sys_Log.add(..., ESYS_LogType.WARNING)` — copy the existing style.
- New EasyEDA-side logic goes in `src/eda/connections.ts`; only the event dispatch goes in
  `src/mcp-client.ts`. Keep pure geometry/planning functions free of `eda` so they are testable.
- Do not touch `src/eda/assemble*.ts`, `place-net.ts` or the cloud calls except where §6 says.
- Keep the existing Russian comments; write new comments in English.

---

## 9. Build, install, and run — step by step

### 9.1 One-time setup

```bash
git clone https://github.com/biosshot/easyeda-copilot.git
cd easyeda-copilot && git checkout -b feature/connection-styles v1.1.9
npm install                 # root (extension)
cd mcp && npm install && cd ..
```

Node ≥ 20 is required (the repo uses `ts-node` for build scripts and `node:test`).

### 9.2 Build the extension (.eext)

```bash
npm run build     # = node build.mjs (vite iframes) && npm run compile (esbuild → dist/index.js) && ts-node build/packaged.ts (zips → build/dist/*.eext)
ls build/dist/    # easyeda-copilot_v1.2.0.eext
grep -c 'restyle-connections' dist/index.js   # sanity: 1 or more
```

### 9.3 Build the MCP server

```bash
cd mcp && npm run check      # typecheck + build + the three check scripts
```

Point Claude Code at the local build instead of the npm package: in `~/.claude.json` change the
`easyeda-copilot` server to `"command": "node", "args": ["/absolute/path/easyeda-copilot/mcp/dist/index.js"]`
(back the file up first). Restart Claude Code.

### 9.4 Install the extension into EasyEDA Pro

1. Quit EasyEDA Pro.
2. If an older Copilot is installed and the in-app uninstall does not remove it, remove the
   extension store: back up then delete
   `~/.config/EasyEDA-Pro/cache.arm64.3/IndexedDB/https_pro.easyeda.com_0.indexeddb.{blob,leveldb}`
   (online mode) — the app recreates it on launch. (This is what the owner did on 2026-09-09.)
3. Launch EasyEDA Pro → Extensions → install from file → your `.eext`. Enable **External
   Interactions** in the extension settings. Restart the app.
4. `lsof -nP -iTCP:8787` must show the MCP server LISTENing and EasyEDA connected.

### 9.5 Test loop

Every code change: `npm run build` (root), reinstall the .eext (steps 9.4.1–3), `npm run build` in
`mcp/`, restart Claude Code, run the tool. It is slow (about two minutes per cycle); batch your
changes and lean on the unit tests.

---

## 10. Acceptance criteria for the whole feature

1. `get_current_page_schematic` without the flag returns byte-identical JSON to v1.1.9 on the same page.
2. With `include_connections:true`, on CruiserCtrl Sheets 02 and 08, every pin's `symbols` list is
   non-empty for every named net, and the counts of `flag` / `port` / `label` agree with what the
   owner sees on screen for a sample of ten pins.
3. `restyle_connections` on twenty pins across two sheets changes zero `signal_name` values
   (read-back diff) and leaves exactly one symbol per restyled wire.
4. `NAME_MISMATCH` and `WOULD_ORPHAN` refusals are demonstrated on the scratch page.
5. `dry_run:true` never calls a mutating `eda.*` method (assert via a log line count in the extension log).
6. A component added with `connection_style` on two pins comes out with exactly the requested
   symbols; without the field, identical to v1.1.9.
7. Unit tests pass: `node --test tests/`.
8. The three docs in §7 are updated and the version is 1.2.0 everywhere.

---

## 11. Estimated effort

| Phase | Work                                                                          | Time   |
| ----- | ----------------------------------------------------------------------------- | ------ |
| 0     | Spike, seven [VERIFY] answers, findings doc                                   | ½ day  |
| 1     | `include_connections` read + tests                                            | 1 day  |
| 2     | `restyle_connections` + dry run + rollback + tests                            | 2 days |
| 3     | `connection_style` on placement                                               | 1 day  |
| —     | Docs, version bump, PR to upstream (`biosshot/easyeda-copilot`), review fixes | ½ day  |

Total about **one working week**. Phases 1 and 2 are independent of each other and can be split
between two people if Phase 0 is done first by whoever takes Phase 2.

---

## 12. Open questions for the owner (ask before Phase 2 if unclear)

- Default `flag_kind` for `PGND`: `Ground` (same triangle as GND) or `ProtectGround` (chassis symbol)? The conventions document (`docs/schematic-conventions.md`) asks for a visibly different symbol, so `ProtectGround` is the suggested default for any net containing `PGND`.
- Should `restyle_connections` on a pin with **no wire and no symbol** (a genuinely unconnected pin) be an error or a no-op? Suggested: error `PIN_UNCONNECTED` — naming a wire that does not exist is a wiring change, not a restyle.
