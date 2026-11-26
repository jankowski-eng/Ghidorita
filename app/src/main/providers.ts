import { readFileSync } from "node:fs";
import path from "node:path";

export interface ProviderLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  resources: string[];
}

interface LaunchContext {
  appDir: string;
  resourcesPath: string;
  userData: string;
  packaged: boolean;
  electron: string;
  token: string;
  env: NodeJS.ProcessEnv;
}

export function providerLaunch(ctx: LaunchContext): ProviderLaunch {
  const env: NodeJS.ProcessEnv = { ...ctx.env, SIDECAR_TOKEN: ctx.token };
  delete env.SIDECAR_ALLOW_NO_AUTH;
  const { appDir, packaged, resourcesPath } = ctx;
  const provider = env.GHIDRETTE_PROVIDER ?? (env.MOCK === "1" ? "mock" : env.SIDECAR_CMD ? "external" : packaged ? distributionProvider(appDir) : "pyghidra");

  switch (provider) {
    case "fixture": {
      const script = packaged
        ? path.join(resourcesPath, "providers", "fixture.cjs")
        : path.join(appDir, "out", "providers", "fixture.cjs");
      return { executable: ctx.electron, args: [script], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, resources: [script] };
    }
    case "mock":
      return { executable: "node", args: [path.join(appDir, "mock/server.mjs")], env, resources: [] };
    case "external": {
      // Preserve the development shortcut. A wrapper executable can handle spaces and arbitrary arguments.
      const [executable, ...args] = (env.SIDECAR_CMD ?? "").trim().split(/\s+/);
      if (!executable) throw new Error("Set SIDECAR_CMD to launch an external provider");
      env.SIDECAR_PROJECTS_DIR ??= path.join(ctx.userData, env.GHIDRETTE_PROVIDER ? "external-projects" : "projects");
      return { executable, args, env, resources: [] };
    }
    case "pyghidra": {
      const root = packaged ? resourcesPath : path.dirname(appDir);
      const executable = path.join(root, packaged ? "python/bin/python3" : "sidecar/.venv/bin/python");
      const script = path.join(root, "sidecar/main.py");
      const resources = [executable, script];
      env.SIDECAR_PROJECTS_DIR ??= path.join(ctx.userData, "projects");
      if (packaged) {
        env.JAVA_HOME = path.join(root, "jdk");
        env.GHIDRA_INSTALL_DIR = path.join(root, "ghidra");
        env.PYTHONNOUSERSITE = "1";
        env.PYTHONPYCACHEPREFIX = path.join(ctx.userData, "pycache"); // bytecode written into the .app would break its code-signature seal
        delete env.PYTHONPATH;
        delete env.PYTHONHOME;
        resources.push(env.JAVA_HOME, env.GHIDRA_INSTALL_DIR);
      }
      return { executable, args: [script], env, resources };
    }
    default:
      throw new Error(`Unknown backend provider: ${provider}`);
  }
}

// fixture.builder.cjs stamps `ghidretteProvider: "fixture"` into the packaged package.json (extraMetadata); the full build has none.
function distributionProvider(appDir: string): string {
  return JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")).ghidretteProvider ?? "pyghidra";
}
