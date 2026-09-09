import type { CircuitMod, ConnectionStyle } from '@copilot/shared/types/circuit';

/** designator → pin number (as string) → style */
export type ConnectionStylesMap = Record<string, Record<string, ConnectionStyle>>;

type CircuitForCloud = Omit<CircuitMod, 'restyle_connections' | 'dry_run'>;

/**
 * The cloud layout service does not know `connection_style` and must not receive it.
 * Returns a deep copy of the circuit with every `connection_style` removed, plus the
 * styles keyed by designator and pin so the extension can apply them after assembly.
 * The input is not mutated.
 */
export function splitConnectionStyles<T extends CircuitForCloud>(input: T): { circuit: T; connectionStyles: ConnectionStylesMap } {
    const circuit = structuredClone(input);
    const connectionStyles: ConnectionStylesMap = {};

    const record = (designator: string, pinNumber: string | number, style: ConnectionStyle | undefined) => {
        if (!style) return;
        (connectionStyles[designator] ??= {})[String(pinNumber)] = style;
    };

    for (const component of circuit.add_components) {
        for (const pin of component.pins) {
            record(component.designator, pin.pin_number, pin.connection_style);
            delete pin.connection_style;
        }
    }

    for (const connect of circuit.external_connect ?? []) {
        record(connect.designator, connect.pin_number, connect.connection_style);
        delete connect.connection_style;
    }

    return { circuit, connectionStyles };
}

export function hasConnectionStyles(map: ConnectionStylesMap): boolean {
    return Object.values(map).some(pins => Object.keys(pins).length > 0);
}
