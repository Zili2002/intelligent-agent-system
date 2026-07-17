import path from "node:path";
import { appendJsonLine } from "@intelligent-agent/shared";

export interface ReaderNotification {
  title: string;
  body: string;
  paperIds?: string[];
  createdAt: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly external: boolean;
  send(notification: ReaderNotification): Promise<void>;
}

export class FileNotificationProvider implements NotificationProvider {
  readonly name = "file";
  readonly external = false;

  constructor(readonly filePath: string) {}

  send(notification: ReaderNotification): Promise<void> {
    return appendJsonLine(path.resolve(this.filePath), notification);
  }
}

export async function sendReaderNotification(
  provider: NotificationProvider,
  notification: ReaderNotification,
  options: { approveExternal?: boolean } = {},
): Promise<void> {
  if (!notification.title.trim() || !notification.body.trim()) {
    throw new Error("Notification title and body are required");
  }
  if (provider.external && options.approveExternal !== true) {
    throw new Error(
      `External notification provider ${provider.name} requires explicit approval`,
    );
  }
  await provider.send(notification);
}
