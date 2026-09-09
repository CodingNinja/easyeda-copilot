# Changelog

## 1.2.5 - 2026-09-09

- `get_current_page_schematic` gains `include_connections`: every pin reports the wire touching it and every naming symbol (power flag, net port, net label) on that wire, so mixed or duplicated net symbols can be seen.
- `connection_style` on `add_components[*].pins` and `external_connect` chooses flag / port (with direction) / label / plain wire per pin when a component is placed. Omitted keeps the previous default rule.
- `restyle_connections` on `extract_circuit_on_current_page` changes the symbol on an existing pin's wire without changing the net, with `dry_run`, netlist verification and automatic rollback. Refuses pins whose wire carries two different names.
- Developer tooling: `debug_dump_net_symbols` (with `EASYEDA_COPILOT_DEBUG=1`), `mcp/scripts/easyeda-request.mjs` to send events through a running bridge, and `npm test` for the extension unit tests.

## 1.1.9 - 2026-09-08

- Use native EasyEDA ground and power symbols, and native net ports in desktop mode, with consistent rotations when creating and cloning schematic components.
- Preserve global net names from flags and ports when reading schematics, including names absent from wire attributes.
- Refine the schematic modification guide and refresh the English, Russian, and Chinese documentation with new examples and demos.

## 1.1.8 - 2026-09-01

- Improved automatic PCB component placement and added `refineGroup` support for controlled post-placement refinement.
- Improved autorouting stability and integrated the npm-published Copilot Router, significantly expanding routing support with differential pairs, stackup-aware impedance-controlled traces, coplanar gaps, and matched-length groups.
- Added topology-aware schematic patterns for more consistent component placement and cleaner generated schematics.
- Expanded and refined the MCP skill documentation, improving the reliability and quality of schematic, PCB placement, routing, and general MCP workflows.
