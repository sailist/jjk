import * as crypto from "crypto";
import * as https from "https";
import { Avatar, JJGraphExtensionState } from "./extensionState";
import { JJGraphLogger } from "./dataSource";
import { Disposable, EventEmitter } from "./utils";

/**
 * Manages fetching and caching Avatars from Gravatar.
 */
export class AvatarManager extends Disposable {
  private readonly extensionState: JJGraphExtensionState;
  private readonly logger: JJGraphLogger;
  private readonly avatarEventEmitter: EventEmitter<AvatarEvent>;

  private avatars: { [email: string]: Avatar };
  private queue: Promise<void> = Promise.resolve();

  /**
   * Creates the JJ Graph Avatar Manager.
   * @param extensionState The JJ Graph ExtensionState instance.
   * @param logger The logger instance.
   */
  constructor(extensionState: JJGraphExtensionState, logger: JJGraphLogger) {
    super();
    this.extensionState = extensionState;
    this.logger = logger;
    this.avatarEventEmitter = new EventEmitter<AvatarEvent>();
    this.avatars = this.extensionState.getAvatarCache();

    this.registerDisposables(this.avatarEventEmitter);
  }

  /**
   * Fetch an avatar, either from the cache if it already exists, or queue it to be fetched from Gravatar.
   * @param email The email address identifying the avatar.
   * @param _repo The repository that the avatar is used in (unused in JJ Graph).
   * @param _remote The remote that the avatar can be fetched from (unused in JJ Graph).
   * @param _commits The commits that reference the avatar (unused in JJ Graph).
   */
  public fetchAvatarImage(
    email: string,
    _repo: string,
    _remote: string | null,
    _commits: string[],
  ) {
    if (typeof this.avatars[email] !== "undefined") {
      const t = new Date().getTime();
      if (
        this.avatars[email].timestamp < t - 1209600000 ||
        (this.avatars[email].image === null && this.avatars[email].timestamp < t - 345600000)
      ) {
        // Refresh avatar after 14 days, or if an avatar couldn't previously be found after 4 days
        this.queueFetch(email);
      } else if (this.avatars[email].image !== null) {
        this.emitAvatar(email);
      }
    } else {
      this.queueFetch(email);
    }
  }

  /**
   * Get the image data of an avatar.
   * @param email The email address identifying the avatar.
   * @returns A base64 encoded data URI if the avatar exists, otherwise NULL.
   */
  public getAvatarImage(email: string): Promise<string | null> {
    if (
      typeof this.avatars[email] !== "undefined" &&
      this.avatars[email].image !== null
    ) {
      return Promise.resolve(this.avatars[email].image);
    }
    return Promise.resolve(null);
  }

  /**
   * Get the Event that can be used to subscribe to receive requested avatars.
   * @returns The Event.
   */
  get onAvatar() {
    return this.avatarEventEmitter.subscribe;
  }

  /**
   * Queue an avatar to be fetched from Gravatar. Fetches are serialised to avoid hammering Gravatar.
   * @param email The email address identifying the avatar.
   */
  private queueFetch(email: string) {
    this.avatars[email] = { image: null, timestamp: new Date().getTime() };
    this.queue = this.queue.then(() => this.fetchFromGravatar(email));
  }

  /**
   * Fetch an avatar from Gravatar.
   * @param email The email address identifying the avatar.
   */
  private async fetchFromGravatar(email: string) {
    this.logger.log("Requesting Avatar for " + maskEmail(email) + " from Gravatar");
    const hash: string = crypto
      .createHash("md5")
      .update(email.trim().toLowerCase())
      .digest("hex");

    const image = await downloadAvatarImage(
      "https://www.gravatar.com/avatar/" + hash + "?d=404&s=162",
    );

    if (image !== null) {
      this.avatars[email] = { image: image, timestamp: new Date().getTime() };
      this.extensionState.saveAvatar(email, this.avatars[email]);
      this.logger.log("Saved Avatar for " + maskEmail(email));
      this.emitAvatar(email);
    } else {
      this.avatars[email] = { image: null, timestamp: new Date().getTime() };
      this.extensionState.saveAvatar(email, this.avatars[email]);
      this.logger.log("No Avatar could be found for " + maskEmail(email));
    }
  }

  /**
   * Emit an AvatarEvent to any listeners.
   * @param email The email address identifying the avatar.
   */
  private emitAvatar(email: string) {
    const avatar = this.avatars[email];
    if (typeof avatar !== "undefined" && avatar.image !== null) {
      this.avatarEventEmitter.emit({ email: email, image: avatar.image });
    }
  }
}

/**
 * Download an avatar image.
 * @param imageUrl The URL the avatar can be downloaded from.
 * @returns A promise that resolves to the data URI of the avatar, or NULL if downloading failed.
 */
function downloadAvatarImage(imageUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let completed = false;
    const complete = (dataUri: string | null = null) => {
      if (!completed) {
        completed = true;
        resolve(dataUri);
      }
    };

    https
      .get(
        imageUrl,
        {
          headers: { "User-Agent": "jjk" },
          agent: false,
          timeout: 15000,
        },
        (res) => {
          const imageBufferArray: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            imageBufferArray.push(chunk);
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              const format = res.headers["content-type"]?.split("/")[1] ?? "png";
              complete(
                "data:image/" +
                  format +
                  ";base64," +
                  Buffer.concat(imageBufferArray).toString("base64"),
              );
            } else {
              complete();
            }
          });
          res.on("error", () => complete());
        },
      )
      .on("error", () => complete());
  }).catch(() => null);
}

/**
 * Mask an email address for logging.
 * @param email The string containing the email address.
 * @returns The masked email address.
 */
function maskEmail(email: string) {
  return email.substring(0, email.indexOf("@")) + "@*****";
}

export interface AvatarEvent {
  email: string;
  image: string;
}
