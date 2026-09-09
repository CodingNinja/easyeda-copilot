# Fixing net symbol conventions on a schematic with EasyEDA Copilot

Audience: an agent (or person) driving the EasyEDA Copilot MCP tools against a real board.
Goal: make every wire on a sheet carry the *right* naming symbol — power flag, net port (In/Out/Bi),
net label, or none — without changing any net.

## 0. Prerequisites

- EasyEDA Pro desktop with the **EasyEDA Copilot extension ≥ 1.2.5** installed and *External Interactions* enabled.
  The stock npm package (`npx easyeda-copilot-mcp`) is 1.1.9 and does **not** have these features.
- The MCP server must be the local build: in `~/.claude.json` point the `easyeda-copilot` server at
  `node <repo>/mcp/dist/index.js`. Restart Claude Code after changing it.
- One EasyEDA instance connected, with the **schematic page you want to fix open and focused**.
  If two instances are connected, call `list_easyeda_instances` then `select_easyeda_instance` first.
- Every mutating call saves a checkpoint automatically. `restore_checkpoint_for_current_page` undoes a call.

## 1. The three ideas

**Symbols name nets; wires don't.** In EasyEDA Pro a wire under a flag or port has an empty net name; the
netlist gets the name from the symbol. A *net label* (what pressing **N** on a wire creates) is the only case
where the name lives on the wire itself.

**Four styles**, one per pin connection:

| `symbol` | Draws | Scope | Typical use |
| --- | --- | --- | --- |
| `flag` | Power flag. `flag_kind`: `Power`, `Ground`, `AnalogGround`, `ProtectGround` | project-wide | GND, PGND, AGND, VBAT, 3V3 rails |
| `port` | Net port. `direction` **required**: `input` = Netport (In), `output` = Netport (Out), `bidirectional` = Netport (Bi) | project-wide (cross-page) | Signals that leave the sheet or block |
| `label` | Net label on the wire | this page only | Signals that stay on the page |
| `wire` | No symbol at all | copper only | Short pin-to-pin runs; refused if it would leave the pin alone |

**A restyle never changes the net.** Each pin is planned from a fresh read, the new symbol is created
*before* the old ones are removed, then the netlist is re-read and the pin must still share its net with
exactly the same pins. Otherwise the change is rolled back and reported.

## 2. Read first: `get_current_page_schematic` with `include_connections: true`

Each pin gains a `connection` object:

```json
"R2.2": { "signal_name": "DUP",
  "connection": { "wire_id": "32e5…", "wire_net": "DUP",
    "symbols": [
      { "type": "label", "name": "DUP", "primitive_id": "32e5…" },
      { "type": "port",  "name": "DUP", "direction": "output", "primitive_id": "3048…" } ] } }
```

How to read it:

- `symbols` lists **every** naming symbol on the whole wire run touching the pin. One entry = clean.
- Two entries with the **same** name (above) = redundant symbols; pick one style.
- Two entries with **different** names = a merged net drawn two ways. The tool will refuse to touch it
  (`NAME_MISMATCH`); a human must fix it in the editor first.
- `symbols: []` with a `wire_id` = plain wire to another pin, or an unnamed stub.
- `wire_id: null` with a symbol = the symbol was dropped straight onto the pin (works, but ugly). A restyle
  will give it a proper 10-unit stub.
- For ports, `direction` tells you which of the three port kinds it is. For a label, `primitive_id` is the wire's id.

Pages with more than 40 components are written to a JSON file; read the file.

## 3. Decide the convention, then restyle

A typical convention for a multi-sheet board:

1. Rails (`GND`, `PGND`, `AGND`, `VBAT…`, `VCC…`, `3V3`…) → `flag`. Let `flag_kind` default
   (`PGND` → ProtectGround, other `*GND*` → Ground, else Power) unless the sheet uses something specific.
2. Signals that go to another sheet → `port` with the true direction (`input` into this sheet, `output` out
   of it, `bidirectional` for buses/I²C-like lines).
3. Signals that stay on the sheet → `label`.
4. Redundant symbols (same name twice) → keep one, remove the rest, by simply requesting the style you want.

Call `extract_circuit_on_current_page` with **only** `restyle_connections` (leave the other fields empty/null).
No cloud request is made in that case, so it is fast and offline:

```json
{
  "add_components": [], "add_reused_blocks": [],
  "rm_components": null, "external_rm_connect": null, "external_connect": null,
  "restyle_connections": [
    { "designator": "R_TIE",  "pin_number": 1, "style": { "symbol": "flag" } },
    { "designator": "R_TIE",  "pin_number": 2, "style": { "symbol": "flag", "flag_kind": "ProtectGround" } },
    { "designator": "U8",     "pin_number": 4, "style": { "symbol": "port", "direction": "input" } },
    { "designator": "U8",     "pin_number": 3, "style": { "symbol": "label" } }
  ],
  "dry_run": true
}
```

Run with `dry_run: true` first. It returns the plan per pin (`create`, `remove`, `keep`, `stub`) and changes
nothing. Then run the same call without `dry_run`. Batch as many pins as you like; each is independent.

### Reading the result (`connectionRestyle`)

| Field | Meaning |
| --- | --- |
| `applied[]` | Done. `noop: true` = already as requested. `created_id`, `removed_ids` for traceability. |
| `skipped[]` | Refused, untouched. `reason` is one of the table below. |
| `errors[]` | Something went wrong. `ROLLED_BACK` = page is as before. `ROLLBACK_FAILED` = call `restore_checkpoint_for_current_page`. |
| `before` / `after` | `designator.pin → net` for the requested pins. They must be identical (except `wire` style, where an auto-name may appear). |
| `scope_changes[]` | Items that crossed label ⇄ port/flag. **Review these against the other sheets** (see §5). |

| `reason` | Why | What to do |
| --- | --- | --- |
| `NAME_MISMATCH` | Wire carries two different names, or symbol ≠ netlist | Fix by hand in EasyEDA, re-read, retry |
| `WOULD_ORPHAN` | `wire` style would leave the pin with no symbol and no other pin | Choose `label`/`port`/`flag` |
| `PIN_UNCONNECTED` | No wire, no symbol | Wire it with `external_connect` (that names it too) |
| `NO_NET_NAME` | Only an auto-name (`$…`) | Name the net with `external_connect` first |
| `NO_FREE_END` | Pin-to-pin wire, no free end for a flag/port | Use `label`, or accept `wire` |

## 4. Placing new parts with the right symbols

When adding components, put `connection_style` on any pin (and on `external_connect` entries). The part is
placed as usual, then the requested symbols are applied on the same checkpoint. Omit it for the old
default (rail-looking names → flag, everything else → bidirectional port).

```json
{ "pin_number": 2, "name": "2", "signal_name": "SPI1_MOSI",
  "connection_style": { "symbol": "port", "direction": "output" } }
```

The result carries `connectionStyleResult` with the same `applied / skipped / errors` shape.

## 5. Scope: the one thing the tool cannot check for you

Connectivity is verified on the **current page** only. Changing a label to a port/flag (`local→global`) may
merge with a same-named net on another sheet; changing a port/flag to a label (`global→local`) may cut a
cross-page link. Both are usually intended, sometimes not. The tool never blocks on this, so bulk edits stay
one pass; instead every such item is listed in `scope_changes`. After a batch, walk that list: for each
`local→global`, confirm no other sheet already uses that name for something else; for each `global→local`,
confirm nothing on another sheet expected that port.

## 6. A complete pass over one sheet

1. Open the sheet in EasyEDA. Read with `include_connections: true`.
2. Build a table `designator.pin → signal_name → symbols`. Flag anything with two different names for the human.
3. Decide the target style per net (rails → flag, cross-sheet → port with direction, local → label).
4. `dry_run: true` with all items. Check `skipped` reasons and that no `create` looks wrong.
5. Run for real. Confirm `before == after` for every pin and `errors` is empty.
6. Re-read with `include_connections: true`: every named pin should now show exactly one symbol.
7. Review `scope_changes` against the other sheets. Repeat per sheet.

## 7. Known limits

- Ports on vertical wire ends: rotation follows the measured model (pin points back at the wire) but has only
  been eyeballed on horizontal runs so far. Check the first vertical one visually.
- Label text position is chosen by EasyEDA; it may sit near a designator. Cosmetic.
- The read uses the Allegro netlist export, so the page must have no duplicate designators.
