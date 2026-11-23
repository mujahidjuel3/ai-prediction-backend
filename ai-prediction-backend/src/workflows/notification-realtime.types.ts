/** Real-time notification payload. REST remains the source of truth for history. */
export type NotificationRealtimeType = 'manual' | 'alert_linked';

export interface NotificationNewEvent {
  id: string;
  type: NotificationRealtimeType;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}
