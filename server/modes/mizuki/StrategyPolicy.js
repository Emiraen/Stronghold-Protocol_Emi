// Keep the shared strategy catalog intact for the other game modes.
export const mizukiStrategyAvailable = bandId => bandId !== 'band_dusk';
export const mizukiStrategyBandId = bandId => mizukiStrategyAvailable(bandId) ? bandId : null;
