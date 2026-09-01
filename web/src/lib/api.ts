/**
 * Base API Client for fetching data from the SURFAI Fastify backend.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';

interface FetchOptions extends RequestInit {
  // Add any custom options here
}

export async function fetchAPI<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  
  const defaultHeaders = {
    'Content-Type': 'application/json',
    // 'Authorization': `Bearer ${token}` // TODO: Add auth token management
  };

  const response = await fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.message || `API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Sessions API
 */
export const sessionsApi = {
  getSessions: async () => {
    // Example: return fetchAPI('/sessions');
    // For now returning mock data as defined in the plan
    return Promise.resolve([]);
  },
  getSessionDetails: async (id: string) => {
    // Example: return fetchAPI(`/sessions/${id}`);
    return Promise.resolve(null);
  }
};

/**
 * Projects API
 */
export const projectsApi = {
  getProjects: async () => {
    return Promise.resolve([]);
  }
};
