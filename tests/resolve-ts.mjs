// Module resolve hook used by tests/setup.mjs. See that file for the rationale.
const RELATIVE_WITHOUT_EXTENSION = /^\.{1,2}\/(?!.*\.[a-zA-Z0-9]+$)/;

export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && RELATIVE_WITHOUT_EXTENSION.test(specifier)) {
            return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
    }
}
