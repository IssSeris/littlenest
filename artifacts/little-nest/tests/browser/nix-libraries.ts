import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Downloaded Playwright engines are ELF binaries, not Nix-wrapped executables.
// Installing their libraries is not enough: the browser subprocess must also
// see the configured packages' library outputs. Resolve these through Nix so
// the test runner never commits machine-specific store hashes.
export function configureNixBrowserLibraries() {
  if (process.platform !== 'linux' || process.env.PASTE_BROWSER_NIX_LIBRARIES_READY === '1') return;
  const config = readFileSync(fileURLToPath(new URL('../../../../.replit', import.meta.url)), 'utf8');
  const packages = config.match(/\[nix\][\s\S]*?packages\s*=\s*(\[[\s\S]*?\])/);
  if (!packages) return; // Non-Nix runners use Playwright's standard host dependencies.
  const attributes = JSON.parse(packages[1]) as string[];
  if (!attributes.every((name) => /^[a-zA-Z0-9_.-]+$/.test(name))) {
    throw new Error('Unexpected Nix package attribute in browser dependency configuration.');
  }
  try {
    execFileSync('nix-instantiate', ['--version'], { stdio: 'pipe' });
  } catch {
    return; // A normal Linux CI host may check out a Replit project without Nix.
  }
  const expression = `let p = import <nixpkgs> {}; in {
    libraries = p.lib.makeLibraryPath [
    ${attributes.map((name) => `p.${name}`).join('\n')}
    (p.lib.getLib p.gcc.cc)
    ];
    mesa = "\${p.mesa}";
    networkModules = "\${p.glib-networking}/lib/gio/modules";
  }`;
  const { libraries, mesa, networkModules } = JSON.parse(execFileSync('nix-instantiate', ['--eval', '--strict', '--json', '--expr', expression], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  })) as { libraries: string; mesa: string; networkModules: string };
  // The downloaded WebKit build needs JPEG XL's 0.8 ABI. Nix's current libjxl
  // package is newer; use a genuinely compatible installed output, never an
  // alias to a different ABI. Replit's shared store includes this older output.
  const compatibleJxl = readdirSync('/nix/store')
    .filter((name) => /-libjxl-0\.8\./.test(name))
    .map((name) => `/nix/store/${name}/lib`)
    .find((dir) => existsSync(`${dir}/libjxl.so.0.8`));
  if (!compatibleJxl) {
    throw new Error('WebKit needs an installed libjxl 0.8 compatibility output in the Nix store.');
  }
  process.env.LD_LIBRARY_PATH = [libraries, compatibleJxl, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  // Playwright's dlopen precheck consults /sbin/ldconfig's Debian cache and
  // ignores LD_LIBRARY_PATH. Nix libraries are not registered in that cache.
  // Check its dynamically loaded requirements ourselves before bypassing
  // that inapplicable host precheck. Missing engines/actual launch errors
  // still fail the tests; this never skips a browser project.
  const directories = process.env.LD_LIBRARY_PATH.split(':');
  for (const soname of ['libGLESv2.so.2', 'libx264.so']) {
    if (!directories.some((dir) => existsSync(`${dir}/${soname}`))) {
      throw new Error(`Missing Nix browser library: ${soname}`);
    }
  }
  // GLVND's standard /usr/share vendor location does not exist on Nix. Tell
  // WebKit's headless EGL renderer where the real Mesa vendor/driver files are.
  process.env.__EGL_VENDOR_LIBRARY_FILENAMES = `${mesa}/share/glvnd/egl_vendor.d/50_mesa.json`;
  process.env.LIBGL_DRIVERS_PATH = `${mesa}/lib/dri`;
  process.env.EGL_PLATFORM = 'surfaceless';
  process.env.LIBGL_ALWAYS_SOFTWARE = '1';
  process.env.GIO_EXTRA_MODULES = networkModules;
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  process.env.PASTE_BROWSER_NIX_LIBRARIES_READY = '1';
}