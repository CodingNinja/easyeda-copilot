import { z } from "zod";
import { LCSC_uuid } from "./lcsc";
import { ReusedCategory, ReusedTags } from "./reused";

export const ConnectionStyleSchema = () => z.object({
    symbol: z.enum(['flag', 'port', 'label', 'wire']).describe(
        'flag = power flag (GND/rail symbol); port = net port — there are three kinds, so `direction` is required: input = "Netport (In)", output = "Netport (Out)", bidirectional = "Netport (Bi)"; '
        + 'label = net label on the wire; wire = no naming symbol (only valid when the pin is joined by a wire to another pin on this page).'),
    direction: z.enum(['input', 'output', 'bidirectional']).optional().describe(
        'Required when symbol is "port": which net port kind to draw (In / Out / Bi). Ignored for other symbols.'),
    flag_kind: z.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround']).optional().describe(
        'Flags only. Default: ProtectGround if the net name contains PGND, Ground if it contains GND, else Power.'),
}).refine(style => style.symbol !== 'port' || !!style.direction, {
    message: 'symbol "port" requires direction: input (Netport In), output (Netport Out) or bidirectional (Netport Bi).',
    path: ['direction'],
});

export const PinSchema = () => z.object({
    pin_number: z.union([z.number(), z.string()]).describe('Pin number.'),
    name: z.string().describe('Pin name (e.g., "VCC").'),
    signal_name: z.string().describe('The name of the signal the pin is connected to. (Name only). The signal name assigned to the pin must be identical to the signal name of the target output.'),
    connection_style: ConnectionStyleSchema().optional().describe(
        'How to draw this pin\'s connection when the component is placed. Omit for the default (rail names → flag, others → port).'),
});

export const BaseComponentSchema = () => z.object({
    designator: z.string().describe('Component identifier (e.g., "U1", "R5", "J1", "X1").'),
    value: z.string().describe('Minimum description: for simple components — only the nominal value; for microcircuits — only the name. Only ASCII symbols (e.g., "LM358", "10nF", "100k").'),
    pins: z.array(PinSchema()).describe('Pin details.'),
    block_name: z.string().describe('Reference to the block.'),
    search_query: z.string().describe('A component search question. For example: "1k 1W smd resistor", "LM358", "2-pin power connector"'),
    part_uuid: LCSC_uuid().nullable().describe("If you know the part_uuid of the lcsc component, be sure to fill in this field; otherwise, fill in null.")
});

export const CircuitReusedBlockSchema = () => z.object({
    block_uuid: z.string(),
    parameters_to_recalc: z.array(z.object({
        name: z.string(),
        new_value: z.number()
    })).describe("Parameters that will be recalculated to suit your needs"),
    ports: z.array(z.object({
        port_number: z.string().or(z.number()).describe("Port number"),
        signal_name: z.string().describe("Port signal_name"),
    }))
});

export const ComponentAsmSchema = () => BaseComponentSchema().extend({
    sub_part_name: z.string().optional(),
    pos: z.object({
        x: z.number().describe("X position"),
        y: z.number().describe("Y position"),
        center: z.object({
            x: z.number(),
            y: z.number()
        }),
        width: z.number().describe("width position"),
        height: z.number().describe("height position"),
        rotate: z.number().optional(),
        mirror: z.boolean().optional()
    }).describe("Position of the component on the Circuit"),
});

const BlockSchema = () => z.object({
    name: z.string().describe('A unique short name for the block (e.g. "Preamp").'),
    description: z.string().describe('Block functionality.'),
    next_block_names: z.array(z.string().describe("The `name` of the next block must be an existing block `name`."))
});

const MetadataSchema = () => z.object({
    project_name: z.string().describe('Project name.'),
    description: z.string().describe('Circuit description.'),
});

export const CircuitStruct = () => z.object({
    metadata: (MetadataSchema().describe('Metadata')),
    blocks: (z.array(BlockSchema()).describe('Blocks')),
    components: (z.array(BaseComponentSchema()).describe('Components')),
    reused_blocks: (z.array(CircuitReusedBlockSchema()).describe('reuded blocks'))
});

export const CircuitBlocksStruct = () => z.object({
    metadata: (MetadataSchema().describe('Metadata')),
    blocks: (z.array(BlockSchema()).describe('Blocks')),
});

export const CircuitWithoutBlocksStruct = () => z.object({
    metadata: MetadataSchema().describe('Metadata'),
    components: z.array(BaseComponentSchema()).describe('Components'),
});

const ElkPoint = () => z.object({
    x: z.number(),
    y: z.number()
})

export const CircuitAssemblyStruct = () => z.object({
    metadata: MetadataSchema().describe('Metadata'),
    components: z.array(ComponentAsmSchema()).describe('Components'),
    reused_blocks: z.array(z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        description: z.string(),
        category: ReusedCategory(),
        tags: z.array(ReusedTags()),
    })).optional(),
    edges: z.array(z.object({
        sources: z.array(z.string()),
        targets: z.array(z.string()),
        container: z.string(),
        sections: z.array(z.object({
            id: z.string(),
            startPoint: ElkPoint(),
            endPoint: ElkPoint(),
            bendPoints: z.array(ElkPoint()).optional(),
            incomingShape: z.string().optional(),
            outgoingShape: z.string().optional(),
            incomingSections: z.array(z.string()).optional(),
            outgoingSections: z.array(z.string()).optional(),
        })),
    })),
    blocks: z.array(BlockSchema()).describe('Blocks'),
    blocks_rect: z.array(z.object({
        name: z.string().describe('Block short name (e.g., "Preamp").'),
        description: z.string().describe('Block functionality.'),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
    })).optional(),
    assembly_options: z.object({
        centered: z.boolean().optional(),
        draw_blocks: z.boolean().optional(),
    }).optional(),
    added_net: z.array(z.object({
        designator: z.string(),
        pin_number: z.union([z.number(), z.string()]),
        net: z.string(),
    })).optional(),
    rm_net: z.array(z.object({
        designator: z.string(),
        pin_number: z.union([z.number(), z.string()]),
        net: z.string(),
    })).optional(),
    rm_components: z.array(z.string()).optional(),
    replace_components: z.array(z.string()).optional(),
});

export const RestyleConnectionSchema = () => z.object({
    designator: z.string().describe('Existing component designator.'),
    pin_number: z.union([z.number(), z.string()]).describe('Pin number on that component.'),
    style: ConnectionStyleSchema(),
});

export const ConnectionSymbolSchema = () => z.object({
    type: z.enum(['flag', 'port', 'label']).describe('Kind of naming symbol found on the wire that touches this pin. A label is the wire\'s own net name.'),
    name: z.string().describe('Net name the symbol carries.'),
    direction: z.enum(['input', 'output', 'bidirectional']).nullable().optional().describe(
        'Ports: which kind — input = Netport (In), output = Netport (Out), bidirectional = Netport (Bi). null only if EasyEDA does not expose it. Absent for flags and labels.'),
    primitive_id: z.string().describe('EasyEDA primitive id of the symbol (for a label: the id of the wire that carries the name).'),
});

export const PinConnectionSchema = () => z.object({
    wire_id: z.string().nullable().describe('Primitive id of the wire touching the pin; null if the pin has no wire.'),
    wire_net: z.string().nullable().describe('The wire\'s own net attribute as EasyEDA reports it; may be an auto-name starting with "$".'),
    symbols: z.array(ConnectionSymbolSchema()).describe('Every naming symbol on that wire. Empty = plain wire to another pin, or unnamed stub.'),
});

const ExplainPinSchema = () => z.object({
    pin_number: z.union([z.number(), z.string()]).describe('Pin number.'),
    name: z.string().describe('Pin name (e.g., "VCC").'),
    signal_name: z.string().describe('The name of the signal the pin is connected to. (Name only). The signal name assigned to the pin must be identical to the signal name of the target output.'),
    connection: PinConnectionSchema().optional().describe('Present only when the schematic was read with include_connections.'),
});

export const ExplainComponentSchema = () => z.object({
    designator: z.string().describe('Component identifier (e.g., "U1", "R5", "J1", "X1").'),
    value: z.string().describe('Minimum description: for simple components — only the nominal value; for microcircuits — only the name. Only ASCII symbols (e.g., "LM358", "10nF", "100k").'),
    pins: z.array(ExplainPinSchema()).describe('Pin details.'),
    part_uuid: LCSC_uuid().nullable().describe('Unique component identifier.'),
    pos: z.object({
        x: z.number(),
        y: z.number(),
        rotate: z.number().optional(),
        mirror: z.boolean().optional()
    }).optional(),
    footprint_name: z.string().nullish(),
    footprint_uuid: z.string().nullish(),
});

export const ExplainCircuitStruct = () => z.object({
    components: z.array(ExplainComponentSchema()).describe('Components'),
});

export const CircuitModStruct = () => z.object({
    add_components: (z.array(BaseComponentSchema().omit({ part_uuid: true }).extend({
        part_uuid: LCSC_uuid().describe("part_uuid of the lcsc component")
    })).describe('Components to add')),
    add_reused_blocks: (z.array(CircuitReusedBlockSchema()).describe('reuded blocks to add')),
    rm_components: ((z.array(z.string().describe('component designator')).nullable().describe('Components to remove from the circuit'))),
    external_rm_connect: ((z.array(z.object({
        designator: z.string().describe('Target component designator'),
        pin_number: z.union([z.number(), z.string()]).describe('Target component pin number'),
    })).nullable())).describe('Use only if you need to remove/break the connection from an external component\'s pin. Remember to remove external_rm_connect first and then add external_connect.'),
    external_connect: ((z.array(z.object({
        designator: z.string().describe('Target component designator'),
        pin_number: z.union([z.number(), z.string()]).describe('Target component pin number'),
        signal_name: z.string().describe('Signal name'),
        connection_style: ConnectionStyleSchema().optional().describe('How to draw the new connection on that pin. Omit for the default.'),
    })).nullable())).describe('Use only when you need to connect to a pin of an external component that you have not modified and that does not have a signal_name'),
    restyle_connections: z.array(RestyleConnectionSchema()).nullable().optional().describe(
        'Change the naming symbol (flag / port / label / plain wire) on the wire of an EXISTING component pin without changing its net. '
        + 'Read the page with get_current_page_schematic(include_connections=true) first. '
        + 'Refused per pin with NAME_MISMATCH when the wire carries two different names, and WOULD_ORPHAN when style "wire" would leave the pin unconnected. '
        + 'May be used alone (no cloud call) or together with the other fields.'),
    dry_run: z.boolean().optional().describe(
        'Only for restyle_connections: report what would be created/removed without touching the page. Rejected if add/remove changes are also present.'),
});

export type CircuitMod = z.infer<ReturnType<typeof CircuitModStruct>>;
export type ExplainCircuit = z.infer<ReturnType<typeof ExplainCircuitStruct>>;
export type CircuitAssembly = z.infer<ReturnType<typeof CircuitAssemblyStruct>>;
export type CircuitWithoutBlocks = z.infer<ReturnType<typeof CircuitWithoutBlocksStruct>>;
export type Circuit = z.infer<ReturnType<typeof CircuitStruct>>;
export type CircuitComponent = z.infer<ReturnType<typeof BaseComponentSchema>>;
export type Pin = z.infer<ReturnType<typeof PinSchema>>;
export type ConnectionSymbol = z.infer<ReturnType<typeof ConnectionSymbolSchema>>;
export type ConnectionStyle = z.infer<ReturnType<typeof ConnectionStyleSchema>>;
export type RestyleConnection = z.infer<ReturnType<typeof RestyleConnectionSchema>>;
export type PinConnection = z.infer<ReturnType<typeof PinConnectionSchema>>;
export type CircuitBlocks = z.infer<ReturnType<typeof CircuitBlocksStruct>>;