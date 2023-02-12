import fs from 'node:fs';

import { FileType } from '../types';
import { FileUtils } from '../utils/FileUtils';
import { logger } from '../utils/Logger';
import { Utils } from '../utils/Utils';

export class AuthorizedTagsCache {
  private static instance: AuthorizedTagsCache | null = null;
  private readonly tagsCaches: Map<string, string[]>;
  private readonly FSWatchers: Map<string, fs.FSWatcher | undefined>;

  private constructor() {
    this.tagsCaches = new Map<string, string[]>();
    this.FSWatchers = new Map<string, fs.FSWatcher | undefined>();
  }

  public static getInstance(): AuthorizedTagsCache {
    if (AuthorizedTagsCache.instance === null) {
      AuthorizedTagsCache.instance = new AuthorizedTagsCache();
    }
    return AuthorizedTagsCache.instance;
  }

  public getAuthorizedTags(file: string): string[] | undefined {
    if (this.hasTags(file) === false) {
      this.setTags(file, this.getAuthorizedTagsFromFile(file));
      // Monitor authorization file
      this.FSWatchers.has(file) === false &&
        this.FSWatchers.set(
          file,
          FileUtils.watchJsonFile(
            file,
            FileType.Authorization,
            this.logPrefix(file),
            undefined,
            (event, filename) => {
              if (Utils.isNotEmptyString(filename) && event === 'change') {
                try {
                  logger.debug(
                    `${this.logPrefix(file)} ${FileType.Authorization} file have changed, reload`
                  );
                  this.deleteTags(file);
                  this.deleteFSWatcher(file);
                } catch (error) {
                  FileUtils.handleFileException(
                    file,
                    FileType.Authorization,
                    error as NodeJS.ErrnoException,
                    this.logPrefix(file),
                    {
                      throwError: false,
                    }
                  );
                }
              }
            }
          )
        );
    }
    return this.getTags(file);
  }

  public deleteAuthorizedTags(file: string): boolean {
    return this.deleteTags(file);
  }

  private hasTags(file: string): boolean {
    return this.tagsCaches.has(file);
  }

  private setTags(file: string, tags: string[]) {
    return this.tagsCaches.set(file, tags);
  }

  private getTags(file: string): string[] | undefined {
    return this.tagsCaches.get(file);
  }

  private deleteTags(file: string): boolean {
    return this.tagsCaches.delete(file);
  }

  private deleteFSWatcher(file: string): boolean {
    this.FSWatchers.get(file)?.close();
    return this.FSWatchers.delete(file);
  }

  private getAuthorizedTagsFromFile(file: string): string[] {
    let authorizedTags: string[] = [];
    if (file) {
      try {
        // Load authorization file
        authorizedTags = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
      } catch (error) {
        FileUtils.handleFileException(
          file,
          FileType.Authorization,
          error as NodeJS.ErrnoException,
          this.logPrefix(file)
        );
      }
    } else {
      logger.info(`${this.logPrefix(file)} No authorization file given`);
    }
    return authorizedTags;
  }

  private logPrefix = (file: string): string => {
    return Utils.logPrefix(` Authorized tags cache for authorization file '${file}' |`);
  };
}
