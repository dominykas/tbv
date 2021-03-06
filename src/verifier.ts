import { Engine, Step } from './engine';

export class Verifier extends Engine<VerifyProgress> {
  async verify(packageName: string, version: string): Promise<boolean> {
    this.progress = createProgress();
    this.hasFailed = false;
    this.hasPrinted = false;

    const { resolvedVersion, repoUrl, gitHead, shasum } = await this.registry(
      packageName,
      version,
    );
    if (this.hasFailed) return false;

    const { tempDir, refspec } = await this.checkout(
      repoUrl,
      gitHead,
      resolvedVersion,
    );
    if (this.hasFailed) return false;

    const { remoteShasum } = await this.pack(tempDir);
    if (this.hasFailed) return false;

    this.compare(shasum, remoteShasum);
    if (this.hasFailed) return false;

    return true;
  }

  private async registry(
    packageName: string,
    version: string,
  ): Promise<{
    resolvedVersion?: string;
    repoUrl?: string;
    shasum?: string;
    gitHead?: string;
  }> {
    this.updateProgress('registry', 'working');

    // Get package info
    let info: any;
    try {
      info = await this.get(`https://registry.npmjs.com/${packageName}`);
    } catch (err) {
      this.updateProgress(
        'registry',
        'fail',
        'Error fetching package data from registry',
      );
      return {};
    }

    // Resolve package version
    const resolvedVersion =
      (info['dist-tags'] && info['dist-tags'][version || 'latest']) || version;
    if (!resolvedVersion) {
      this.updateProgress(
        'registry',
        'fail',
        `Cannot resolve version ${version}`,
      );
      return {};
    }

    // Find version info
    const versionInfo = !!info.versions && info.versions[resolvedVersion];
    if (!versionInfo) {
      this.updateProgress(
        'registry',
        'fail',
        `Cannot find info for version ${resolvedVersion} <<<<`,
      );
      return {};
    }

    this.updateProgress('registry', 'pass');
    this.updateProgress('repo', 'working');

    // Find repository info
    if (!versionInfo.repository) {
      this.updateProgress(
        'repo',
        'fail',
        `Repository is not specified for version ${resolvedVersion}`,
      );
      return {};
    }

    // Check repository type
    if (versionInfo.repository.type !== 'git') {
      this.updateProgress(
        'repo',
        'fail',
        `Non-git (${
          versionInfo.repository.type
        }) repository specified for version ${resolvedVersion}`,
      );
      return {};
    }

    // Check repository URL
    if (!versionInfo.repository.url) {
      this.updateProgress(
        'repo',
        'fail',
        `Repository URL is not specified for version ${resolvedVersion}`,
      );
      return {};
    }
    const repoUrl = versionInfo.repository.url.startsWith('git+')
      ? versionInfo.repository.url.substring(4)
      : versionInfo.repository.url;

    this.updateProgress('repo', 'pass');
    this.updateProgress('gitHead', 'working');

    // Check for gitHead
    if (!versionInfo.gitHead) {
      this.updateProgress(
        'gitHead',
        'warn',
        `GitHead is not specified for version ${resolvedVersion}`,
      );
    }

    this.updateProgress('gitHead', 'pass');

    const shasum =
      versionInfo['_shasum'] || (versionInfo.dist && versionInfo.dist.shasum);

    return { resolvedVersion, repoUrl, shasum };
  }

  private async checkout(
    repoUrl: string,
    gitHead: string,
    resolvedVersion: string,
  ): Promise<{ tempDir?: string; refspec?: string }> {
    this.updateProgress('checkout', 'working');
    const cwd = process.cwd();
    let tempDir = '';

    // Create temp directory
    try {
      tempDir = await this.createTemp();
    } catch (err) {
      this.updateProgress('checkout', 'fail', 'Error creating temp directory');
      return {};
    }

    process.chdir(tempDir);

    // git init
    try {
      await this.exec('git init');
    } catch (err) {
      this.updateProgress(
        'checkout',
        'fail',
        'Error initializing git repo in temp directory',
      );
      process.chdir(cwd);
      return { tempDir };
    }

    // add remote
    try {
      await this.exec(`git remote add origin "${repoUrl}"`);
    } catch (err) {
      this.updateProgress(
        'checkout',
        'fail',
        'Error initializing git repo in temp directory',
      );
      process.chdir(cwd);
      return { tempDir };
    }

    // fetch from remote
    let refspec: string;
    if (gitHead) {
      // Try by gitHead
      try {
        await this.exec(`git fetch --depth 1 origin ${gitHead}`);
        refspec = gitHead;
      } catch (err) {
        this.updateProgress(
          'checkout',
          'fail',
          `Unable fetch commit from remote (${gitHead.substring(0, 7)})`,
        );
        process.chdir(cwd);
        return { tempDir };
      }
    } else {
      // Try by v-prefixed version tag
      try {
        await this.exec(`git fetch --depth 1 origin tags/v${resolvedVersion}`);
        refspec = `tags/v${resolvedVersion}`;
      } catch {
        // Try by non-prefixed version tag
        try {
          await this.exec(`git fetch --depth 1 origin tags/${resolvedVersion}`);
          refspec = `tags/${resolvedVersion}`;
        } catch (err) {
          this.updateProgress(
            'checkout',
            'fail',
            `Unable fetch tag from remote (tags/${resolvedVersion} or tags/v${resolvedVersion})`,
          );
          process.chdir(cwd);
          return { tempDir };
        }
      }
    }

    // checkout fetch head
    try {
      await this.exec('git checkout FETCH_HEAD');
    } catch (err) {
      this.updateProgress('checkout', 'fail', 'Unable to checkout FETCH_HEAD');
      process.chdir(cwd);
      return { tempDir, refspec };
    }

    process.chdir(cwd);
    this.updateProgress('checkout', 'pass');
    return { tempDir, refspec };
  }

  private async pack(tempDir: string): Promise<{ remoteShasum?: string }> {
    this.updateProgress('pack', 'working');

    const cwd = process.cwd();
    process.chdir(tempDir);

    // npm pack
    let stdout: string = null;
    let failedWithoutDependencies = false;
    try {
      stdout = await this.exec(`npm pack --dry-run`);
      this.updateProgress('install', 'skipped');
    } catch (err) {
      failedWithoutDependencies = true;
    }

    if (failedWithoutDependencies) {
      // install dependencies
      try {
        this.updateProgress('pack', 'pending', 'Waiting for dependencies');
        this.updateProgress('install', 'working');
        await this.exec(`npm ci`);
        this.updateProgress('install', 'pass');
      } catch (err) {
        this.updateProgress('install', 'fail', 'Error installing dependencies');
        process.chdir(cwd);
        return {};
      }

      // npm pack (again)
      try {
        this.updateProgress('pack', 'working');
        stdout = await this.exec(`npm pack --dry-run`);
      } catch (err) {
        this.updateProgress(
          'pack',
          'fail',
          'Error creating package from remote files' + err,
        );
        process.chdir(cwd);
        return {};
      }
    }

    // parse shasum from stdout
    let remoteShasum = '';
    try {
      remoteShasum = /shasum:\s+([0-9a-f]{40})/.exec(stdout)[1];
    } catch (parseErr) {
      this.updateProgress(
        'pack',
        'fail',
        'Error parsing shasum from pack output',
      );
      process.chdir(cwd);
      return {};
    }

    this.updateProgress('pack', 'pass');
    process.chdir(cwd);
    return { remoteShasum };
  }

  private compare(registryShasum: string, remoteShasum: string): void {
    this.updateProgress('compare', 'working');

    if (registryShasum === remoteShasum) {
      this.updateProgress('compare', 'pass');
    } else {
      this.updateProgress('compare', 'fail', 'Shasums do not match');
    }
  }
}

function createProgress(): VerifyProgress {
  return {
    registry: {
      status: 'pending',
      title: 'Fetch package data from registry',
    },
    repo: {
      status: 'pending',
      title: 'Version contains repository URL',
    },
    gitHead: {
      status: 'pending',
      title: 'Version contains gitHead',
    },
    checkout: {
      status: 'pending',
      title: 'Shallow checkout',
    },
    install: {
      status: 'pending',
      title: 'Install npm packages',
    },
    pack: {
      status: 'pending',
      title: 'Create package',
    },
    compare: {
      status: 'pending',
      title: 'Compare shasums',
    },
  };
}

export type VerifyProgress = {
  registry: Step;
  repo: Step;
  gitHead: Step;
  checkout: Step;
  install: Step;
  pack: Step;
  compare: Step;
};
