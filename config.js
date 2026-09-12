// Meridian System — Configuration
// Credentials are read from environment variables (never commit them)

module.exports = {
  topstepx: {
    username:    process.env.TOPSTEPX_USERNAME || '',
    altUsername: process.env.TOPSTEPX_ALT_USERNAME || '',
    password:    process.env.TOPSTEPX_PASSWORD || '',   // Used by Puppeteer browser login
    apiKey:      process.env.TOPSTEPX_API_KEY || '',
    apiBase:     'https://api.topstepx.com',
    loginUrl:    'https://app.topstepx.com'
  },

  claude: {
    apiKey:    process.env.ANTHROPIC_API_KEY || '',
    model:     'claude-sonnet-4-6',
    maxTokens: 3000,
    apiBase:   'https://api.anthropic.com'
  },

  trading: {
    defaultContractId:   'CON.F.US.MES.H26',
    defaultContractName: 'Micro E-mini S&P 500',
    tickSize:    0.25,
    tickValue:   1.25,    // Per tick per contract (MES)
    contracts:   3,       // Number of contracts per trade
    commissionPerContract: 0.74, // Round-trip commission per contract (TopstepX)
    loopFrequency:       10000,    // ms — main scalping loop
    macroUpdateFrequency: 3600000, // ms — macro context refresh (1 hour)
    maxDailyTrades: 100,
    maxDailyLoss:   200
  }
};
