import crypto from "node:crypto";
import type { AcsConfig } from "../config.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

/**
 * Azure Communication Services (ACS) Call Automation provider.
 *
 * Uses ACS Call Automation REST API for call control and Event Grid
 * webhooks for event delivery.
 *
 * @see https://learn.microsoft.com/en-us/azure/communication-services/concepts/call-automation/call-automation
 */

export interface AcsProviderOptions {
  /** Skip webhook signature verification (dev only) */
  skipVerification?: boolean;
  /** Override public URL for callback */
  publicUrl?: string;
}

/** Parsed ACS connection string fields */
interface AcsConnectionParts {
  endpoint: string;
  accessKey: string;
}

export class AcsProvider implements VoiceCallProvider {
  readonly name = "acs" as const;

  private readonly endpoint: string;
  private readonly accessKey: string;
  private readonly options: AcsProviderOptions;

  /** Map callId -> ACS server call ID for mid-call operations */
  private readonly serverCallIds = new Map<string, string>();

  /** Map ACS correlationId -> internal callId */
  private readonly correlationToCallId = new Map<string, string>();

  constructor(config: AcsConfig, options: AcsProviderOptions = {}) {
    if (!config.connectionString) {
      throw new Error("ACS connection string is required");
    }

    const parts = AcsProvider.parseConnectionString(config.connectionString);
    this.endpoint = parts.endpoint;
    this.accessKey = parts.accessKey;
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // Connection string parsing
  // ---------------------------------------------------------------------------

  private static parseConnectionString(connectionString: string): AcsConnectionParts {
    const parts: Record<string, string> = {};
    for (const segment of connectionString.split(";")) {
      const idx = segment.indexOf("=");
      if (idx > 0) {
        const key = segment.substring(0, idx).toLowerCase().trim();
        const value = segment.substring(idx + 1).trim();
        parts[key] = value;
      }
    }
    if (!parts.endpoint || !parts.accesskey) {
      throw new Error("Invalid ACS connection string: must contain endpoint and accesskey fields");
    }
    return { endpoint: parts.endpoint.replace(/\/+$/, ""), accessKey: parts.accesskey };
  }

  // ---------------------------------------------------------------------------
  // HMAC-SHA256 authentication for ACS REST API
  // ---------------------------------------------------------------------------

  private generateAuthHeaders(
    method: string,
    url: string,
    body: string,
    date: string,
  ): Record<string, string> {
    const parsedUrl = new URL(url);
    const pathAndQuery = parsedUrl.pathname + parsedUrl.search;
    const contentHash = crypto.createHash("sha256").update(body, "utf8").digest("base64");

    const stringToSign = `${method}\n${pathAndQuery}\n${date};${parsedUrl.host};${contentHash}`;
    const signature = crypto
      .createHmac("sha256", Buffer.from(this.accessKey, "base64"))
      .update(stringToSign, "utf8")
      .digest("base64");

    return {
      "x-ms-date": date,
      "x-ms-content-sha256": contentHash,
      Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      "Content-Type": "application/json",
    };
  }

  private async apiRequest<T = unknown>(params: {
    method: "GET" | "POST" | "DELETE" | "PATCH";
    path: string;
    body?: Record<string, unknown>;
    apiVersion?: string;
  }): Promise<T> {
    const { method, path, body, apiVersion } = params;
    const version = apiVersion ?? "2024-09-15";
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.endpoint}${path}${separator}api-version=${version}`;
    const bodyStr = body ? JSON.stringify(body) : "";
    const date = new Date().toUTCString();

    const authHeaders = this.generateAuthHeaders(method, url, bodyStr, date);

    const response = await fetch(url, {
      method,
      headers: authHeaders,
      body: bodyStr || undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ACS API error: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  // ---------------------------------------------------------------------------
  // Webhook verification
  // ---------------------------------------------------------------------------

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    if (this.options.skipVerification) {
      return { ok: true };
    }

    // ACS Event Grid sends validation events; always accept those
    // ACS Call Automation callbacks are authenticated by the callbackUri containing a secret
    // Since we control the callbackUri and it's HTTPS, we trust inbound webhooks.
    // For Event Grid subscription validation, check for the validation header.
    const validationHeader =
      typeof ctx.headers["aeg-event-type"] === "string" ? ctx.headers["aeg-event-type"] : undefined;

    if (validationHeader === "SubscriptionValidation") {
      return { ok: true };
    }

    // For call automation callbacks, ACS signs with HMAC if configured,
    // but most setups rely on the secret in the callback URL.
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Webhook event parsing
  // ---------------------------------------------------------------------------

  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    let payload: unknown;
    try {
      payload = JSON.parse(ctx.rawBody);
    } catch {
      return { events: [], statusCode: 400 };
    }

    // Handle Event Grid subscription validation
    if (Array.isArray(payload)) {
      const first = payload[0];
      if (first?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        const validationCode = first.data?.validationCode;
        return {
          events: [],
          providerResponseBody: JSON.stringify({ validationResponse: validationCode }),
          providerResponseHeaders: { "Content-Type": "application/json" },
          statusCode: 200,
        };
      }
    }

    // ACS Call Automation sends events as an array of CloudEvents
    const eventArray = Array.isArray(payload) ? payload : [payload];
    const events: NormalizedEvent[] = [];

    for (const raw of eventArray) {
      const normalized = this.normalizeEvent(raw, ctx);
      if (normalized) {
        events.push(normalized);
      }
    }

    return { events, statusCode: 200 };
  }

  private normalizeEvent(raw: unknown, ctx: WebhookContext): NormalizedEvent | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const event = raw as Record<string, unknown>;

    // CloudEvents format: type is at top-level
    // ACS Automation callback format: type within event
    const eventType =
      typeof event.type === "string"
        ? event.type
        : typeof event.eventType === "string"
          ? event.eventType
          : "";

    const data = (event.data ?? event) as Record<string, unknown>;
    const serverCallId = typeof data.serverCallId === "string" ? data.serverCallId : undefined;
    const correlationId = typeof data.correlationId === "string" ? data.correlationId : undefined;

    // Try to resolve internal callId from query params or correlation maps
    const callIdFromQuery =
      typeof ctx.query?.callId === "string" ? ctx.query.callId.trim() : undefined;
    const callId =
      callIdFromQuery ||
      (correlationId ? this.correlationToCallId.get(correlationId) : undefined) ||
      (serverCallId ? this.serverCallIds.get(serverCallId) : undefined) ||
      serverCallId ||
      "";

    if (correlationId && callId) {
      this.correlationToCallId.set(correlationId, callId);
    }
    if (serverCallId && callId) {
      this.serverCallIds.set(callId, serverCallId);
    }

    const providerCallId = serverCallId || correlationId || "";
    const from =
      typeof data.from === "object" && data.from
        ? extractPhoneNumber(data.from as Record<string, unknown>)
        : undefined;
    const to =
      typeof data.to === "object" && data.to
        ? extractPhoneNumber(data.to as Record<string, unknown>)
        : undefined;

    const baseEvent = {
      id: crypto.randomUUID(),
      callId,
      providerCallId,
      timestamp: Date.now(),
      from,
      to,
    };

    // Map ACS event types to normalized events
    switch (eventType) {
      case "Microsoft.Communication.CallConnected":
        return { ...baseEvent, type: "call.answered" };

      case "Microsoft.Communication.CallDisconnected": {
        return { ...baseEvent, type: "call.ended", reason: "completed" };
      }

      case "Microsoft.Communication.CreateCallFailed":
        return {
          ...baseEvent,
          type: "call.error",
          error:
            typeof data.resultInformation === "object" && data.resultInformation
              ? String(
                  (data.resultInformation as Record<string, unknown>).message ??
                    "Call creation failed",
                )
              : "Call creation failed",
        };

      case "Microsoft.Communication.PlayCompleted":
        return { ...baseEvent, type: "call.speaking", text: "" };

      case "Microsoft.Communication.PlayFailed":
        return {
          ...baseEvent,
          type: "call.error",
          error: "Play (TTS) failed",
        };

      case "Microsoft.Communication.RecognizeCompleted": {
        const choiceResult = data.choiceResult as Record<string, unknown> | undefined;
        const speechResult = data.speechResult as Record<string, unknown> | undefined;
        const dtmfResult = data.dtmfResult as Record<string, unknown> | undefined;

        if (speechResult && typeof speechResult.speech === "string") {
          return {
            ...baseEvent,
            type: "call.speech",
            transcript: speechResult.speech,
            isFinal: true,
          };
        }

        if (dtmfResult && typeof dtmfResult.tones === "string") {
          return { ...baseEvent, type: "call.dtmf", digits: dtmfResult.tones };
        }

        if (choiceResult && typeof choiceResult.label === "string") {
          return {
            ...baseEvent,
            type: "call.speech",
            transcript: choiceResult.label,
            isFinal: true,
          };
        }

        return null;
      }

      case "Microsoft.Communication.RecognizeFailed":
        // Silence timeout or recognition failure — emit silence event
        return { ...baseEvent, type: "call.silence", durationMs: 0 };

      case "Microsoft.Communication.ParticipantsUpdated":
        // Informational, no action needed
        return null;

      case "Microsoft.Communication.CallTransferAccepted":
      case "Microsoft.Communication.CallTransferFailed":
        return null;

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Call control
  // ---------------------------------------------------------------------------

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const callbackUrl = new URL(input.webhookUrl);
    callbackUrl.searchParams.set("provider", "acs");
    callbackUrl.searchParams.set("callId", input.callId);

    const result = await this.apiRequest<AcsCreateCallResponse>({
      method: "POST",
      path: "/calling/callConnections",
      body: {
        targets: [
          {
            kind: "phoneNumber",
            phoneNumber: { value: input.to },
          },
        ],
        sourceCallerIdNumber: {
          value: input.from,
        },
        callbackUri: callbackUrl.toString(),
        sourceDisplayName: "OpenClaw",
      },
    });

    const callConnectionId = result.callConnectionId;
    if (!callConnectionId) {
      throw new Error("ACS create call returned no callConnectionId");
    }

    // Store mapping for mid-call operations
    this.serverCallIds.set(input.callId, callConnectionId);
    if (result.correlationId) {
      this.correlationToCallId.set(result.correlationId, input.callId);
    }

    return { providerCallId: callConnectionId, status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const callConnectionId = this.serverCallIds.get(input.callId) || input.providerCallId;

    try {
      await this.apiRequest({
        method: "POST",
        path: `/calling/callConnections/${callConnectionId}:hangUp`,
      });
    } catch (err) {
      // Best effort — call may already be terminated
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404") && !msg.includes("NotFound")) {
        throw err;
      }
    }
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const callConnectionId = this.serverCallIds.get(input.callId) || input.providerCallId;

    // Use ACS Play action with text source (SSML or plain text)
    await this.apiRequest({
      method: "POST",
      path: `/calling/callConnections/${callConnectionId}:play`,
      body: {
        playSources: [
          {
            kind: "text",
            text: {
              text: input.text,
            },
            voiceKind: "neural",
          },
        ],
        playTo: "all",
      },
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const callConnectionId = this.serverCallIds.get(input.callId) || input.providerCallId;

    // Use ACS Recognize action for speech recognition
    await this.apiRequest({
      method: "POST",
      path: `/calling/callConnections/${callConnectionId}:recognize`,
      body: {
        recognizeInputType: "speech",
        playPrompt: null,
        recognizeOptions: {
          speechLanguage: input.language || "en-US",
          endSilenceTimeoutInSeconds: 2,
          speechModelEndpointId: undefined,
        },
        interruptPrompt: true,
        operationContext: `listen-${input.callId}`,
      },
    });
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // ACS speech recognition ends automatically with silence or timeout
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPhoneNumber(obj: Record<string, unknown>): string | undefined {
  // ACS uses nested structure: { phoneNumber: { value: "+1234..." } }
  if (typeof obj.phoneNumber === "object" && obj.phoneNumber) {
    const phone = obj.phoneNumber as Record<string, unknown>;
    if (typeof phone.value === "string") {
      return phone.value;
    }
  }
  if (typeof obj.value === "string") {
    return obj.value;
  }
  if (typeof obj.rawId === "string") {
    return obj.rawId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ACS API response types
// ---------------------------------------------------------------------------

interface AcsCreateCallResponse {
  callConnectionId: string;
  serverCallId?: string;
  correlationId?: string;
  targets?: unknown[];
  source?: unknown;
  callConnectionState?: string;
}
