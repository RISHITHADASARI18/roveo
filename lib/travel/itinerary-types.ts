export type PlannerPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category?: string;
  description?: string;
  address?: string;
  websiteUrl?: string;
  destinationId?: string | null;
  openingHours?: string;
  visitDurationMinutes?: number;
};
