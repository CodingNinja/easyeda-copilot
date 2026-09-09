# Changelog

## 1.2.8 - 2026-09-09

- Report the plan that was executed when a connection restyle fails verification, naming the symbol that was created, its position and rotation, and the symbols that were removed, so a rolled-back item can be diagnosed from the log alone.

## 1.2.7 - 2026-09-09

- Re-create a power flag or net port natively when a restyle has to clear the net name held by the wire. Flags and ports placed by circuit assembly carry the net name only as a property, which the netlist ignores, so keeping one left the net unnamed and the change was rolled back.

## 1.2.6 - 2026-09-09

- Stop warning about pin-less pseudo-components such as sheet frames when reading connections, and describe a pin that sits on several wire primitives as ordinary information, since the whole connected wire run is always inspected.

## 1.2.5 - 2026-09-09

- Report every restyled pin whose naming symbol changed between page-local and project-wide scope, so bulk edits stay a single pass and the crossings can be reviewed against the other sheets afterwards.

## 1.2.4 - 2026-09-09

- Place naming symbols with the rotation that points their pin back at the wire, measured from hand-drawn net ports and power flags, replacing the rotation rule borrowed from circuit assembly that stood ports upright on horizontal wires.
- Create the stub wire for a symbol dropped directly on a pin without a net name, so the stub itself no longer reads as a net label.
- Report whether a net label was written by the label call or by setting the wire's net name.

## 1.2.3 - 2026-09-09

- List the attributes of each wire and each naming symbol in the diagnostic dump, since EasyEDA only returns attributes when asked for a specific parent primitive.

## 1.2.2 - 2026-09-09

- Read a net label as the wire's own net name, which is how EasyEDA Pro stores a label typed with the label shortcut, so labelled wires are reported instead of appearing to have no naming symbol.
- Report the kind of a net port, In, Out or Bi, read from the native port symbol, and require the kind when a port is requested so nothing is drawn as a generic port.
- Draw a short stub for a naming symbol placed directly on a pin before restyling it, instead of attaching the new symbol to the zero-length wire EasyEDA leaves there.

## 1.2.1 - 2026-09-09

- Bump the patch version of the extension and the MCP server on every build, so each build installs into EasyEDA Pro as a new extension instead of being treated as already installed. Releases built in continuous integration keep their tagged version.

## 1.2.0 - 2026-09-09

- `get_current_page_schematic` gains `include_connections`: every pin reports the wire touching it and every naming symbol (power flag, net port, net label) on that wire, so mixed or duplicated net symbols can be seen.
- `connection_style` on `add_components[*].pins` and `external_connect` chooses flag / port (with direction) / label / plain wire per pin when a component is placed. Omitted keeps the previous default rule.
- `restyle_connections` on `extract_circuit_on_current_page` changes the symbol on an existing pin's wire without changing the net, with `dry_run`, netlist verification and automatic rollback. Refuses pins whose wire carries two different names.
- Developer tooling: `debug_dump_net_symbols` (with `EASYEDA_COPILOT_DEBUG=1`), `mcp/scripts/easyeda-request.mjs` to send events through a running bridge, `mcp/scripts/mcp-call.mjs` to call a tool on the local MCP build, and `npm test` for the extension unit tests.

## 1.1.9 - 2026-09-08

- Use native EasyEDA ground and power symbols, and native net ports in desktop mode, with consistent rotations when creating and cloning schematic components.
- Preserve global net names from flags and ports when reading schematics, including names absent from wire attributes.
- Refine the schematic modification guide and refresh the English, Russian, and Chinese documentation with new examples and demos.

## 1.1.8 - 2026-09-01

- Improved automatic PCB component placement and added `refineGroup` support for controlled post-placement refinement.
- Improved autorouting stability and integrated the npm-published Copilot Router, significantly expanding routing support with differential pairs, stackup-aware impedance-controlled traces, coplanar gaps, and matched-length groups.
- Added topology-aware schematic patterns for more consistent component placement and cleaner generated schematics.
- Expanded and refined the MCP skill documentation, improving the reliability and quality of schematic, PCB placement, routing, and general MCP workflows.
