/**
 * pm2 process file for the Devora21 API.
 *
 * Production (default):
 *   npx pm2 start ecosystem.config.cjs --only devora21-api
 *
 * Dev watch (iteration only):
 *   npx pm2 start ecosystem.config.cjs --only devora21-api-dev
 */
module.exports = {
  apps: [
    {
      name: "devora21-api",
      cwd: __dirname,
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: "5s",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "devora21-api-dev",
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "watch src/server.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: "5s",
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
