module.exports = {
  apps: [
    {
      name: "voip-vc-server",
      script: "./server/server.js",
      cwd: "/opt/voip-vc",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "0.0.0.0"
      }
    }
  ]
};
