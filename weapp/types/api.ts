export interface Membership {
  id: string;
  planId: string;
  planName: string;
  status: string;
  expiresAt: string;
}

export interface User {
  id: string;
  phone: string;
  nickname: string;
  avatarUrl: string;
  credits: number;
  status: string;
  preferredAiModelId?: string;
  membership: Membership | null;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  version: string;
  price: number;
  suffix: string;
  credits: number;
  quota: number;
  features: string[];
}

export interface Prompt {
  id: string;
  title: string;
  taskType: string;
  scene: string;
  userDescription: string;
  promptPreview: string;
  promptQuarter?: string;
  categoryTags: string[];
  creditCost: number;
  defaultParams?: {
    ratio?: string;
    size?: string;
    resolution?: string;
  };
  exampleImageUrl?: string;
  resultImageUrl?: string;
  exampleImages?: Array<{
    originalUrl: string;
    compressedUrl: string;
  }>;
}

export interface Model {
  id: string;
  name: string;
  defaultSize?: string;
  creditCost?: Record<string, number>;
}

export interface Task {
  id: string;
  taskNo: string;
  promptTitle: string;
  aiModelName: string;
  taskType: string;
  status: string;
  creditCost: number;
  size: string;
  count: number;
  inputImageUrl?: string;
  inputImageUrls?: string[];
  resultImageUrls?: string[];
  failureReason?: string;
  providerLatencyMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
