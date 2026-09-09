# Bug: restyle rolls back (`net changed to $…`) on wires with three symbols — CruiserBCM Sheet 01, 2026-09-09

Extension 1.2.5, instance CruiserBCM, page `30968987fbc1647d` (Sheet 01). Fifteen-pin restyle run: 11 pins
succeeded, 4 rolled back. All four share one shape: the wire run touching the pin carries **three**
same-named symbols (label + port + flag, or label + flag + flag). Every two-symbol wire on the page
restyled fine.

| Pin | Net | wire_id (pin side) | Symbols removed (ids) | Planned create | Result |
|---|---|---|---|---|---|
| TVS1.1 | VBAT_RAW | cbe206e2b808420f | label f30878630e1d4aba, port 8532ce0ba14f2316, flag 9ac9b59f113148e3 | flag Power @ (435,420) rot 0 | ROLLED_BACK: net → `$2N3` |
| C1.1 | VBAT_PWR | b3575484da899a0a | label 79af8de900004b5f, port 96e850f5922dda8a, flag 4db769fe86044c6e | flag Power @ (135,490) | ROLLED_BACK: net → `$2N13` |
| C1.2 | PGND | 2d9d6b19345f25fb | label c09a4e394095440d, flag d99ac9bc3a34329e, flag e353d7883b564cc7 | flag ProtectGround @ (215,490) rot 180 | ROLLED_BACK: net → `$2N24` |
| C3.1 | VBAT_PWR | 6b6ec4d4fb316d74 | label dcdb7cf5db6f4633, port dc8433337902b0e1, flag d0b672df823a4b26 | flag Power @ (255,375) | ROLLED_BACK: net → `$2N20` |

Second experiment: TVS1.1 restyled to **`label`** alone (keep/create label, remove port + flag) → same
failure, net → `$2N3`. So after the port and flag are removed, the remaining/created label does not name
the wire segment the pin sits on. Hypothesis: the "wire run" the cluster walk assembles (endpoint sharing)
contains a wire primitive that EasyEDA's netlister does not consider joined to the pin's segment (e.g. an
overlap or T without a junction), so any symbol on that far segment stops naming the pin's segment once
the port/flag that sat on the pin's own segment is deleted. The planner should (a) verify with a dry
netlist read that the chosen free end is on a segment EasyEDA joins to the pin, or (b) place the new
symbol on the pin's own segment (a new stub off the pin if needed) rather than on the far free end.

Rollback worked in all five cases: `before == after`, page unchanged. Raw outputs: `/tmp/cs/01_dry.json`,
`/tmp/cs/01_applied2.json`, `/tmp/cs/tvs_1.json`; reads `/tmp/cs/01_read*.json`.
