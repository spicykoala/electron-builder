import BluebirdPromise from "bluebird-lst"
import { addValue, Arch, archFromString, isEmptyOrSpaces, warn } from "builder-util"
import { CancellationToken } from "builder-util-runtime"
import { executeFinally } from "builder-util/out/promise"
import chalk from "chalk"
import { PublishOptions } from "electron-publish"
import { deepAssign } from "read-config-file/out/deepAssign"
import { PublishManager, PackagerOptions, DIR_TARGET, Platform, Configuration } from "electron-builder-lib"
import { normalizePlatforms, Packager } from "electron-builder-lib/out/packager"

/** @internal */
export interface BuildOptions extends PackagerOptions, PublishOptions {
}

export interface CliOptions extends PackagerOptions, PublishOptions {
  arch?: string

  x64?: boolean
  ia32?: boolean
  armv7l?: boolean

  dir?: boolean

  platform?: string

  project?: string
}

/** @internal */
export function normalizeOptions(args: CliOptions): BuildOptions {
  if (args.targets != null) {
    return args
  }

  if ((args as any).draft != null || (args as any).prerelease != null) {
    warn("--draft and --prerelease is deprecated, please set releaseType (http://electron.build/configuration/publish#GithubOptions-releaseType) in the GitHub publish options instead")
  }

  let targets = new Map<Platform, Map<Arch, Array<string>>>()

  function processTargets(platform: Platform, types: Array<string>) {
    function commonArch(currentIfNotSpecified: boolean): Array<Arch> {
      if (platform === Platform.MAC) {
        return args.x64 || currentIfNotSpecified ? [Arch.x64] : []
      }

      const result = Array<Arch>()
      if (args.x64) {
        result.push(Arch.x64)
      }
      if (args.armv7l) {
        result.push(Arch.armv7l)
      }
      if (args.ia32) {
        result.push(Arch.ia32)
      }

      return result.length === 0 && currentIfNotSpecified ? [archFromString(process.arch)] : result
    }

    if (args.platform != null) {
      throw new Error(`--platform cannot be used if --${platform.buildConfigurationKey} is passed`)
    }
    if (args.arch != null) {
      throw new Error(`--arch cannot be used if --${platform.buildConfigurationKey} is passed`)
    }

    let archToType = targets.get(platform)
    if (archToType == null) {
      archToType = new Map<Arch, Array<string>>()
      targets.set(platform, archToType)
    }

    if (types.length === 0) {
      const defaultTargetValue = args.dir ? [DIR_TARGET] : []
      for (const arch of commonArch(args.dir === true)) {
        archToType.set(arch, defaultTargetValue)
      }
      return
    }

    for (const type of types) {
      const suffixPos = type.lastIndexOf(":")
      if (suffixPos > 0) {
        addValue(archToType, archFromString(type.substring(suffixPos + 1)), type.substring(0, suffixPos))
      }
      else {
        for (const arch of commonArch(true)) {
          addValue(archToType, arch, type)
        }
      }
    }
  }

  if (args.mac != null) {
    processTargets(Platform.MAC, args.mac)
  }

  if (args.linux != null) {
    processTargets(Platform.LINUX, args.linux)
  }

  if (args.win != null) {
    processTargets(Platform.WINDOWS, args.win)
  }

  if (targets.size === 0) {
    if (args.platform == null && args.arch == null) {
      processTargets(Platform.current(), [])
    }
    else {
      targets = createTargets(normalizePlatforms(args.platform), args.dir ? DIR_TARGET : null, args.arch)
    }
  }

  const result = {...args}
  result.targets = targets

  delete result.dir
  delete result.mac
  delete result.linux
  delete result.win
  delete result.platform
  delete result.arch

  const r = result as any
  delete r.em

  delete r.m
  delete r.o
  delete r.l
  delete r.w
  delete r.windows
  delete r.macos
  delete r.$0
  delete r._
  delete r.version
  delete r.help
  delete r.c

  delete result.ia32
  delete result.x64
  delete result.armv7l

  if (result.project != null && result.projectDir == null) {
    result.projectDir = result.project
  }
  delete result.project

  let config = result.config
  const deprecatedExtraMetadata = r.extraMetadata
  delete r.extraMetadata

  // config is array when combining dot-notation values with a config file value (#2016)
  if (Array.isArray(config)) {
    const newConfig: Configuration = {}

    for (const configItem of config) {
      if (typeof configItem === "object") {
        deepAssign(newConfig, configItem)
      }
      else if (typeof configItem === "string") {
        newConfig.extends = configItem
      }
    }

    config = newConfig
    result.config = newConfig
  }

  if (deprecatedExtraMetadata != null) {
    if (typeof config === "string") {
      // transform to object and specify path to config as extends
      config = {
        extends: config,
        extraMetadata: deprecatedExtraMetadata,
      };
      (result as any).config = config
    }
    else if (config == null) {
      config = {};
      (result as any).config = config
    }
    (config as any).extraMetadata = deprecatedExtraMetadata
  }

  if (config != null && typeof config !== "string") {
    if (config.extraMetadata != null) {
      coerceTypes(config.extraMetadata)
    }
    if (config.mac != null) {
      // ability to disable code sign using -c.mac.identity=null
      coerceValue(config.mac, "identity")
    }
  }

  return result as BuildOptions
}

function coerceValue(host: any, key: string): void {
  const value = host[key]
  if (value === "true") {
    host[key] = true
  }
  else if (value === "false") {
    host[key] = false
  }
  else if (value === "null") {
    host[key] = null
  }
  else if (key === "version" && typeof value === "number") {
    host[key] = value.toString()
  }
  else if (value != null && typeof value === "object") {
    coerceTypes(value)
  }
}

/** @private */
export function coerceTypes(host: any): any {
  for (const key of Object.getOwnPropertyNames(host)) {
    coerceValue(host, key)
  }
  return host
}

export function createTargets(platforms: Array<Platform>, type?: string | null, arch?: string | null): Map<Platform, Map<Arch, Array<string>>> {
  const targets = new Map<Platform, Map<Arch, Array<string>>>()
  for (const platform of platforms) {
    const archs = platform === Platform.MAC ? [Arch.x64] : (arch === "all" ? [Arch.x64, Arch.ia32] : [archFromString(arch == null ? process.arch : arch)])
    const archToType = new Map<Arch, Array<string>>()
    targets.set(platform, archToType)

    for (const arch of archs) {
      archToType.set(arch, type == null ? [] : [type])
    }
  }
  return targets
}

export function build(rawOptions?: CliOptions): Promise<Array<string>> {
  const options = normalizeOptions(rawOptions || {})

  if (options.cscLink === undefined && !isEmptyOrSpaces(process.env.CSC_LINK)) {
    options.cscLink = process.env.CSC_LINK
  }
  if (options.cscInstallerLink === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_LINK)) {
    options.cscInstallerLink = process.env.CSC_INSTALLER_LINK
  }
  if (options.cscKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_KEY_PASSWORD)) {
    options.cscKeyPassword = process.env.CSC_KEY_PASSWORD
  }
  if (options.cscInstallerKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_KEY_PASSWORD)) {
    options.cscInstallerKeyPassword = process.env.CSC_INSTALLER_KEY_PASSWORD
  }

  return _build(options)
}

export async function _build(options: CliOptions, cancellationToken: CancellationToken = new CancellationToken()): Promise<Array<string>> {
  const packager = new Packager(options, cancellationToken)

  let electronDownloader: any = null
  packager.electronDownloader = options => {
    if (electronDownloader ==  null) {
      electronDownloader = BluebirdPromise.promisify(require("electron-download-tf"))
    }
    return electronDownloader(options)
  }

  // because artifact event maybe dispatched several times for different publish providers
  const artifactPaths = new Set<string>()
  packager.artifactCreated(event => {
    if (event.file != null) {
      artifactPaths.add(event.file)
    }
  })

  const publishManager = new PublishManager(packager, options)
  const sigIntHandler = () => {
    warn("Cancelled by SIGINT")
    cancellationToken.cancel()
    publishManager.cancelTasks()
  }
  process.once("SIGINT", sigIntHandler)

  return await executeFinally(packager.build().then(() => Array.from(artifactPaths)), errorOccurred => {
    let promise: Promise<any>
    if (errorOccurred) {
      publishManager.cancelTasks()
      promise = BluebirdPromise.resolve(null)
    }
    else {
      promise = publishManager.awaitTasks()
    }

    return promise
      .then(() => process.removeListener("SIGINT", sigIntHandler))
  })
}

/**
 * @private
 * @internal
 */
export function configureBuildCommand(yargs: yargs.Yargs): yargs.Yargs {
  const publishGroup = "Publishing:"
  const buildGroup = "Building:"
  const deprecated = "Deprecated:"

  return yargs
    .option("mac", {
      group: buildGroup,
      alias: ["m", "o", "macos"],
      description: `Build for macOS, accepts target list (see ${chalk.underline("https://goo.gl/5uHuzj")}).`,
      type: "array",
    })
    .option("linux", {
      group: buildGroup,
      alias: "l",
      description: `Build for Linux, accepts target list (see ${chalk.underline("https://goo.gl/4vwQad")})`,
      type: "array",
    })
    .option("win", {
      group: buildGroup,
      alias: ["w", "windows"],
      description: `Build for Windows, accepts target list (see ${chalk.underline("https://goo.gl/jYsTEJ")})`,
      type: "array",
    })
    .option("x64", {
      group: buildGroup,
      description: "Build for x64",
      type: "boolean",
    })
    .option("ia32", {
      group: buildGroup,
      description: "Build for ia32",
      type: "boolean",
    })
    .option("armv7l", {
      group: buildGroup,
      description: "Build for armv7l",
      type: "boolean",
    })
    .option("dir", {
      group: buildGroup,
      description: "Build unpacked dir. Useful to test.",
      type: "boolean",
    })
    .option("publish", {
      group: publishGroup,
      alias: "p",
      description: `Publish artifacts (to GitHub Releases), see ${chalk.underline("https://goo.gl/tSFycD")}`,
      choices: ["onTag", "onTagOrDraft", "always", "never", undefined as any],
    })
    .option("draft", {
      group: deprecated,
      description: "Please set releaseType in the GitHub publish options instead",
      type: "boolean",
      default: undefined,
    })
    .option("prerelease", {
      group: deprecated,
      description: "Please set releaseType in the GitHub publish options instead",
      type: "boolean",
      default: undefined,
    })
    .option("platform", {
      group: deprecated,
      description: "The target platform (preferred to use --mac, --win or --linux)",
      choices: ["mac", "win", "linux", "darwin", "win32", "all", undefined as any],
    })
    .option("arch", {
      group: deprecated,
      description: "The target arch (preferred to use --x64 or --ia32)",
      choices: ["ia32", "x64", "all", undefined as any],
    })
    .option("extraMetadata", {
      alias: ["em"],
      group: buildGroup,
      description: "Deprecated. Use -c.extraMetadata.",
    })
    .option("prepackaged", {
      alias: ["pd"],
      group: buildGroup,
      description: "The path to prepackaged app (to pack in a distributable format)",
    })
    .option("projectDir", {
      alias: ["project"],
      group: buildGroup,
      description: "The path to project directory. Defaults to current working directory.",
    })
    .option("config", {
      alias: ["c"],
      group: buildGroup,
      description: "The path to an electron-builder config. Defaults to `electron-builder.yml` (or `json`, or `json5`), see " + chalk.underline("https://goo.gl/YFRJOM"),
    })
    .group(["help", "version"], "Other:")
    .example("electron-builder -mwl", "build for macOS, Windows and Linux")
    .example("electron-builder --linux deb tar.xz", "build deb and tar.xz for Linux")
    .example("electron-builder --win --ia32", "build for Windows ia32")
    .example("electron-builder --em.foo=bar", "set package.json property `foo` to `bar`")
    .example("electron-builder --config.nsis.unicode=false", "configure unicode options for NSIS")
}
