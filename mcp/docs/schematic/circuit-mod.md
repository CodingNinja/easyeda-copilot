# Circuit modification rules

## Component search

Prefer the exact manufacturer MPN. A descriptive query such as `1k 1% 0805 resistor` may be used only to discover candidates when an exact MPN is not yet known. Select a real returned component and keep its exact `part_uuid` and manufacturer MPN.

Never invent an MPN or UUID. Confirm package, electrical ratings, tolerance, and relevant limits before selecting among candidates. Every added component requires a real non-null `part_uuid`.

When several library results are electrically and mechanically equivalent, prefer the symbol whose returned `pin_name` values are meaningful, such as `VIN`, `EN`, or `GND`, over one whose names are only `1`, `2`, and `3`. Exact MPN, ratings, and footprint remain higher priority. Numeric pin names are normal for symmetric passives and are not a reason to reject them.

## Functional blocks

Group components by a completed function and local signal path, not by component type.

- Keep an op-amp, transistor, regulator, or main IC with the input, feedback, gain, bias, compensation, and local filtering parts that make its stage work.
- Do not split one amplifier into separate `OpAmp` and `Resistors` blocks.
- A one- or two-component block is appropriate only for a self-contained function or endpoint, such as a connector, fuse, or LED with its resistor.
- If extraction produced fragmented block names, correct them in one final beautify call.

## Extraction

`extract_circuit_on_current_page` can add and remove components and change external connections on the opened page.

- Replace a component by removing it and adding the replacement with the same base designator.
- Use identical `signal_name` values for pins on the same net.
- For an intentionally unconnected pin, leave `signal_name` empty (`""`).
- Using `NC` as a signal name or net label is forbidden. Never use it as a no-connect marker or placeholder.
- Do not add unrelated protection, filtering, or future signals unless requested or required by the selected proven block.
- Combine known related changes, but do not force unrelated or risky work into one call merely to reduce tool count.
- Read the returned `sheetSpace`. When it warns that less than `10%` remains, continue substantial new work on the appropriate functional page instead of packing more independent circuitry onto the current page.

## Reused blocks

Search by function, inspect returned parameters and ports, and use the exact block UUID. Map every exposed port to an intentional signal name. A close but unsuitable reused block is not preferred over a correct explicit circuit.

## Connection symbols

A pin's connection can be drawn with one of four symbols. EasyEDA treats all of them as the same net; the choice is purely how the sheet reads.

| `symbol` | Meaning | Use for |
| --- | --- | --- |
| `flag` | Power flag (native GND / rail symbol). `flag_kind`: `Power`, `Ground`, `AnalogGround`, `ProtectGround`. | Ground and supply rails |
| `port` | Net port. There are three kinds and `direction` is **required**: `input` = Netport (In), `output` = Netport (Out), `bidirectional` = Netport (Bi). | Signals leaving the block or the page |
| `label` | Net label on the wire. In EasyEDA Pro this is the wire's own net name (what pressing **N** sets), so its `primitive_id` is the wire's id. | Signals within a page, hand-drawn style |
| `wire` | No naming symbol. Only valid when the wire already reaches another pin on the page. | Short point-to-point connections |

Default when `connection_style` is omitted: names containing `GND` become a `flag` (kind `Ground`, or `ProtectGround` when the name contains `PGND`), other rail-like names (`VCC…`, `V…`, `BATTERY`, `USB_V…`) become a `Power` flag, everything else becomes a `port`. This is unchanged from earlier versions.

### Reading what is on the page

Call `get_current_page_schematic` with `include_connections: true`. Every pin gains `connection`:

```json
{ "pin_number": 1, "name": "1", "signal_name": "GND",
  "connection": { "wire_id": "e3…", "wire_net": "GND",
                  "symbols": [ { "type": "flag", "name": "GND", "direction": null, "primitive_id": "e4…" } ] } }
```

- `symbols` lists every naming symbol on the whole wire run touching the pin (the run may be several wire primitives). Two entries with different `name`s means the page draws one net two ways; fix that by hand before restyling.
- An empty `symbols` with a `wire_id` is a plain wire to another pin or an unnamed stub. `wire_id: null` with a symbol means the symbol sits directly on the pin.
- For ports, `direction` tells the kind: `input` (Netport In), `output` (Netport Out) or `bidirectional` (Netport Bi). It is read from the native port symbol.

### Choosing the symbol when placing

Add `connection_style` to any pin in `add_components[*].pins` or to any `external_connect` entry:

```json
{ "pin_number": 2, "name": "2", "signal_name": "SIG_X",
  "connection_style": { "symbol": "port", "direction": "input" } }
```

The component is placed exactly as before; the requested symbols are applied afterwards on the same checkpoint. The result includes `connectionStyleResult` with `applied`, `skipped` and `errors`.

### Restyling existing pins

`extract_circuit_on_current_page` accepts `restyle_connections`, alone or together with other changes:

```json
{ "add_components": [], "add_reused_blocks": [], "rm_components": null,
  "external_rm_connect": null, "external_connect": null,
  "restyle_connections": [
    { "designator": "R_SLEEP", "pin_number": 1, "style": { "symbol": "flag" } },
    { "designator": "U8", "pin_number": 4, "style": { "symbol": "port", "direction": "input" } }
  ],
  "dry_run": true }
```

Rules:

1. Read first with `include_connections: true`; restyle only pins whose `symbols` carry a single name.
2. A restyle never changes a net. Each pin is planned from a fresh page read, the new symbol is created **before** the old ones are removed, and the netlist is re-read to confirm the pin still shares its net with the same pins. On any difference the change is rolled back and reported with `ROLLED_BACK` (or `ROLLBACK_FAILED`, in which case restore the checkpoint that was saved automatically).
3. `dry_run: true` reports the plan (`stub`, `create`, `remove`, `keep`) and touches nothing. It is rejected when the same call also adds or removes components or connections.
4. When a call contains only `restyle_connections`, no layout request is sent to the cloud service.

Scope. A label joins same-named wires on the **same page** only; ports and flags join nets **across pages** of the project. Converting a label to a port/flag (`local→global`) can merge with a same-named net on another sheet; converting a port/flag to a label (`global→local`) can cut a cross-page connection. The tool verifies connectivity on the current page only and never blocks on scope, so bulk edits stay fast. Every applied item that crosses scope is listed in `connectionRestyle.scope_changes` (`{ pin, net, change }`); review that list against the other sheets afterwards.

Per-pin refusals (`skipped`, nothing changed for that pin):

| `reason` | Why |
| --- | --- |
| `NAME_MISMATCH` | The wire carries two different names, or the symbol's name differs from the netlist. A merged net is a human's problem. |
| `WOULD_ORPHAN` | `symbol: "wire"` would leave the pin's wire without a symbol and without another pin. |
| `PIN_UNCONNECTED` | The pin has no wire and no symbol. Naming it is a wiring change: use `external_connect`. |
| `NO_NET_NAME` | The net only has an automatic name (`$…`). Name it with `external_connect` first. |
| `NO_FREE_END` | The wire runs pin to pin with no free end for a flag/port. Use `label` instead. |

Removing a net label: the label is the wire's net attribute, so it is removed by clearing that attribute (`label_removal: "wire_net_cleared"`). If EasyEDA refuses an empty net the wire is deleted and re-created without one (`"wire_recreated"`).
