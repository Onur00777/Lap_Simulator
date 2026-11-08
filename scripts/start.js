const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

function run() {
  const needsBuild = !fs.existsSync('.next/BUILD_ID');
  const nextBin = require.resolve('next/dist/bin/next');

  if (needsBuild) {
    console.log('> apexlapsim: Production build not found. Running "next build" first...');
    try {
      execFileSync(process.execPath, [nextBin, 'build'], { stdio: 'inherit' });
    } catch (e) {
      console.error('> apexlapsim: Build failed.', e.message);
      process.exit(1);
    }
  }

  const child = spawn(process.execPath, [nextBin, 'start'], { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

run();
