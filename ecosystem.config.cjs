module.exports = {
  apps: [{
    name: 'local-assets',
    script: 'server/index.js',
    env: {
      REDIS_URL: 'redis://default:EapARAxvCGtllbU9Z0hPVG5Lxp4oFyAF@redis-18082.crce287.eu-west-2-2.ec2.cloud.redislabs.com:18082',
      PROD_MUX_TOKEN_ID: '720a461d-fe18-4e3f-a599-914f71a3c15b',
      PROD_MUX_TOKEN_SECRET: 'mLPy9U3sZK6n0n00CVA53VXv72tng5lMhLtuB/W2ADnV04G5hlChXhJGkJCITTvvsLaZ8FEe4Yf',
      VENUES_CONFIG: ''
    }
  }]
}
