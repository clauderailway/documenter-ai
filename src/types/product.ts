export type ProductStatus = 'pending' | 'processing' | 'done' | 'error';

export type OutputLanguage = 'fa' | 'fa_en' | 'en';
export type ContentTone = 'commercial' | 'technical' | 'minimal';
export type LongDescFormat = 'structured' | 'html';
export type WebpFitMode = 'contain_white' | 'inside';
export type DomainProfile = 'medical' | 'general';
export type AiProviderType = 'gemini' | 'openrouter' | 'openai' | 'groq' | 'custom' | 'pollinations';

export interface CustomProviderProfile {
  id: string;
  name: string;
  type: Exclude<AiProviderType, 'gemini'>;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface EnrichmentSettings {
  domainProfile: DomainProfile;
  storeName: string;
  wpImageBaseUrl: string;
  outputLanguage: OutputLanguage;
  tone: ContentTone;
  longDescFormat: LongDescFormat;
  webpMaxWidth: number;
  webpQuality: number;
  webpFitMode: WebpFitMode;
  targetImageCount: number;
  aiProviderId: string;
  customProviders: CustomProviderProfile[];
  geminiApiKey: string;
  openrouterApiKey: string;
  groqApiKey: string;
  autoFreeFallback: boolean;
}

export interface ProductSpec {
  label: string;
  value: string;
}

export interface ProductSource {
  title: string;
  url: string;
  domain: string;
}

export interface WebpImageAsset {
  id: string;
  url: string;
  sourceUrl: string;
  sourceDomain: string;
  width: number;
  height: number;
  sizeBytes: number;
  selected: boolean;
  isPrimary: boolean;
}

export interface EnrichedProduct {
  id: string;
  query: string;
  seedUrl?: string;
  seedImage?: WebpImageAsset;
  status: ProductStatus;
  errorMessage?: string;
  titleFa: string;
  titleEn: string;
  slug: string;
  brand: string;
  category: string;
  modelCode: string;
  shortDescription: string;
  longDescription: string;
  longDescriptionHtml: string;
  specs: ProductSpec[];
  images: WebpImageAsset[];
  sources: ProductSource[];
  searchQueries: string[];
  updatedAt: number;
}

export const DEFAULT_SETTINGS: EnrichmentSettings = {
  domainProfile: 'medical',
  storeName: 'آرال هلث (تجهیزات پزشکی)',
  wpImageBaseUrl: 'https://aralhealth.com/wp-content/uploads/products/',
  outputLanguage: 'fa',
  tone: 'commercial',
  longDescFormat: 'html',
  webpMaxWidth: 1000,
  webpQuality: 85,
  webpFitMode: 'contain_white',
  targetImageCount: 5,
  aiProviderId: 'gemini-default',
  customProviders: [],
  geminiApiKey: '',
  openrouterApiKey: '',
  groqApiKey: '',
  autoFreeFallback: true,
};
