import { AnthropicProvider } from './registry';

// Configura o provider Anthropic
export function setupAnthropicProvider(env?: Record<string, string>) {
  // Apenas retorna o provedor configurado
  // A chave API será obtida diretamente das variáveis de ambiente do servidor
  return new AnthropicProvider();
}
