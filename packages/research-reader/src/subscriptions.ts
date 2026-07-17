import { randomUUID } from "node:crypto";
import type {
  ReaderSubscription,
  ReaderSubscriptions,
  SubscriptionKind,
} from "./types.js";
import { safeReaderId } from "./validation.js";

export interface CreateSubscriptionInput {
  id?: string;
  name: string;
  kind: SubscriptionKind;
  query: string;
  weight?: number;
  tags?: string[];
  preferredLanguages?: string[];
  enabled?: boolean;
  providers?: ReaderSubscription["providers"];
}

export function addSubscription(
  subscriptions: ReaderSubscriptions,
  input: CreateSubscriptionInput,
  now = new Date(),
): ReaderSubscription {
  if (!input.name.trim())
    throw new Error("Subscription name must not be empty");
  if (!input.query.trim())
    throw new Error("Subscription query must not be empty");
  const id = safeReaderId(
    input.id ?? `subscription-${randomUUID()}`,
    "Reader subscription ID",
  );
  if (subscriptions.items.some((item) => item.id === id)) {
    throw new Error(`Subscription already exists: ${id}`);
  }
  const timestamp = now.toISOString();
  const subscription: ReaderSubscription = {
    version: 1,
    id,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    kind: input.kind,
    query: input.query.trim(),
    weight: input.weight ?? 1,
    tags: unique(input.tags ?? []),
    preferredLanguages: unique(input.preferredLanguages ?? []),
    ...(input.providers?.length
      ? { providers: [...new Set(input.providers)] }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  subscriptions.items.push(subscription);
  subscriptions.items.sort((left, right) => left.id.localeCompare(right.id));
  return subscription;
}

export function setSubscriptionEnabled(
  subscriptions: ReaderSubscriptions,
  subscriptionId: string,
  enabled: boolean,
  now = new Date(),
): ReaderSubscription {
  const subscription = findSubscription(subscriptions, subscriptionId);
  subscription.enabled = enabled;
  subscription.updatedAt = now.toISOString();
  return subscription;
}

export function removeSubscription(
  subscriptions: ReaderSubscriptions,
  subscriptionId: string,
): ReaderSubscription {
  const index = subscriptions.items.findIndex(
    (item) => item.id === subscriptionId,
  );
  if (index < 0) throw new Error(`Subscription not found: ${subscriptionId}`);
  return subscriptions.items.splice(index, 1)[0]!;
}

function findSubscription(
  subscriptions: ReaderSubscriptions,
  subscriptionId: string,
): ReaderSubscription {
  const subscription = subscriptions.items.find(
    (item) => item.id === subscriptionId,
  );
  if (!subscription)
    throw new Error(`Subscription not found: ${subscriptionId}`);
  return subscription;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
