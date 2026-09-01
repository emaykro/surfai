module.exports = {
  apps: [
    {
      name: 'surfai-web',
      script: 'npm',
      args: 'start',
      cwd: '/var/www/surfai/web', // Change this to actual deployment path
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3001, // Running frontend on port 3001
        NEXT_PUBLIC_API_URL: 'http://localhost:3000/api' // Backend URL
      }
    }
  ]
};
