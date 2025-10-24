module.exports = {
  apps: [{
    name: 'forward-arweave',
    script: 'bun',
    args: 'run index.ts',
    cwd: '/home/vilenarios/source/arweave-smtp-bridge',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    merge_logs: true
  }]
};
