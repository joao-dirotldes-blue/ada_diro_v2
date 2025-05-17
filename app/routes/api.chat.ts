import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT, getDynamicContinuePrompt } from '~/lib/common/prompts/prompts';
import { StreamingMessageParser } from '~/lib/runtime/message-parser';

// Cache global para manter instâncias do StreamingMessageParser entre chamadas à API
const parserInstanceCache = new Map<string, StreamingMessageParser>();
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import type { ContextAnnotation, ProgressAnnotation } from '~/types/context';
import { WORK_DIR } from '~/utils/constants';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { extractPropertiesFromMessage } from '~/lib/.server/llm/utils';

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  const { messages, files, promptId, contextOptimization, supabase } = await request.json<{
    messages: Messages;
    files: any;
    promptId?: string;
    contextOptimization: boolean;
    supabase?: {
      isConnected: boolean;
      hasSelectedProject: boolean;
      credentials?: {
        anonKey?: string;
        supabaseUrl?: string;
      };
    };
  }>();

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(
    parseCookies(cookieHeader || '').providers || '{}',
  );

  const stream = new SwitchableStream();

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const encoder: TextEncoder = new TextEncoder();
  let progressCounter: number = 1;

  try {
    const totalMessageContent = messages.reduce((acc, message) => acc + message.content, '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    let lastChunk: string | undefined = undefined;

    const dataStream = createDataStream({
      async execute(dataStream) {
        const filePaths = getFilePaths(files || {});
        let filteredFiles: FileMap | undefined = undefined;
        let summary: string | undefined = undefined;
        let messageSliceId = 0;

        if (messages.length > 3) {
          messageSliceId = messages.length - 3;
        }

        if (filePaths.length > 0 && contextOptimization) {
          logger.debug('Generating Chat Summary');
          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Analysing Request',
          } satisfies ProgressAnnotation);

          // Create a summary of the chat
          console.log(`Messages count: ${messages.length}`);

          summary = await createSummary({
            messages: [...messages],
            env: context.cloudflare?.env,
            apiKeys,
            providerSettings,
            promptId,
            contextOptimization,
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('createSummary token usage', JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });
          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'complete',
            order: progressCounter++,
            message: 'Analysis Complete',
          } satisfies ProgressAnnotation);

          dataStream.writeMessageAnnotation({
            type: 'chatSummary',
            summary,
            chatId: messages.slice(-1)?.[0]?.id,
          } as ContextAnnotation);

          // Update context buffer
          logger.debug('Updating Context Buffer');
          dataStream.writeData({
            type: 'progress',
            label: 'context',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Determining Files to Read',
          } satisfies ProgressAnnotation);

          // Select context files
          console.log(`Messages count: ${messages.length}`);
          filteredFiles = await selectContext({
            messages: [...messages],
            env: context.cloudflare?.env,
            apiKeys,
            files,
            providerSettings,
            promptId,
            contextOptimization,
            summary,
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('selectContext token usage', JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          if (filteredFiles) {
            logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);
          }

          dataStream.writeMessageAnnotation({
            type: 'codeContext',
            files: Object.keys(filteredFiles).map((key) => {
              let path = key;

              if (path.startsWith(WORK_DIR)) {
                path = path.replace(WORK_DIR, '');
              }

              return path;
            }),
          } as ContextAnnotation);

          dataStream.writeData({
            type: 'progress',
            label: 'context',
            status: 'complete',
            order: progressCounter++,
            message: 'Code Files Selected',
          } satisfies ProgressAnnotation);

          // logger.debug('Code Files Selected');
        }

        const options: StreamingOptions = {
          supabaseConnection: supabase,
          toolChoice: 'none',
          onFinish: async ({ text: content, finishReason, usage }) => {
            logger.debug('usage', JSON.stringify(usage));

            if (usage) {
              cumulativeUsage.completionTokens += usage.completionTokens || 0;
              cumulativeUsage.promptTokens += usage.promptTokens || 0;
              cumulativeUsage.totalTokens += usage.totalTokens || 0;
            }

            if (finishReason !== 'length') {
              dataStream.writeMessageAnnotation({
                type: 'usage',
                value: {
                  completionTokens: cumulativeUsage.completionTokens,
                  promptTokens: cumulativeUsage.promptTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                },
              });
              dataStream.writeData({
                type: 'progress',
                label: 'response',
                status: 'complete',
                order: progressCounter++,
                message: 'Response Generated',
              } satisfies ProgressAnnotation);
              await new Promise((resolve) => setTimeout(resolve, 0));

              // stream.close();
              return;
            }

            if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
              throw Error('Cannot continue message: Maximum segments reached');
            }

            const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

            logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`);

            const lastUserMessage = messages.filter((x) => x.role == 'user').slice(-1)[0];
            const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
            
            // Gerar um ID de chat consistente baseado na conversa atual
            const chatId = messages.length > 0 ? messages[0].id : 'default-chat';
            
            // Criar a mensagem do assistente com um ID fixo para podermos referenciar depois
            const assistantMsgId = `assistant-${Date.now()}`;
            messages.push({ id: assistantMsgId, role: 'assistant', content });
            
            // Obter ou criar um parser para este chat do cache global
            let messageParser: StreamingMessageParser;
            if (parserInstanceCache.has(chatId)) {
              messageParser = parserInstanceCache.get(chatId)!;
              logger.info(`Using existing parser for chat ${chatId}`);
            } else {
              messageParser = new StreamingMessageParser({
                callbacks: {
                  onArtifactOpen: (data) => {
                    logger.debug(`[Parser Debug] Artifact opened: ${data.id}, ${data.title}`);
                  },
                  onActionOpen: (data) => {
                    logger.debug(`[Parser Debug] Action opened: ${data.action.type}, filePath: ${(data.action as any).filePath || 'N/A'}`);
                  },
                  onActionClose: (data) => {
                    logger.debug(`[Parser Debug] Action closed: ${data.action.type}`);
                  },
                  onArtifactClose: (data) => {
                    logger.debug(`[Parser Debug] Artifact closed: ${data.id}`);
                  }
                }
              });
              parserInstanceCache.set(chatId, messageParser);
              logger.info(`Created new parser for chat ${chatId}`);
            }
            
            // Processar explicitamente o conteúdo para garantir que o parser tenha estado
            messageParser.parse(assistantMsgId, content);
            
            // Registrar o estado atual do parser para depuração
            const parserState = messageParser.getParserState(assistantMsgId);
            logger.info(`[Parser State antes da continuação] Inside artifact: ${parserState.insideArtifact}, Inside action: ${parserState.insideAction}, Action type: ${parserState.currentAction?.type || 'N/A'}`);
            
            logger.info(`[Parser State] Inside artifact: ${parserState.insideArtifact}, Inside action: ${parserState.insideAction}, Action type: ${parserState.currentAction?.type || 'N/A'}`);
            
            // Gerar o prompt de continuação baseado no estado do parser
            const continuePrompt = getDynamicContinuePrompt(parserState);
            
            messages.push({
              id: generateId(),
              role: 'user',
              content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${continuePrompt}`,
            });

            const result = await streamText({
              messages,
              env: context.cloudflare?.env,
              options,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              contextFiles: filteredFiles,
              summary,
              messageSliceId,
            });

            result.mergeIntoDataStream(dataStream);

            (async () => {
              for await (const part of result.fullStream) {
                if (part.type === 'error') {
                  const error: any = part.error;
                  logger.error(`${error}`);

                  return;
                }
              }
            })();

            return;
          },
        };

        dataStream.writeData({
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation);

        // Inicializar o parser para a primeira chamada também
        const chatId = messages.length > 0 ? messages[0].id : 'default-chat';
        
        // Criar ou recuperar o parser para este chat
        if (!parserInstanceCache.has(chatId)) {
          const initialParser = new StreamingMessageParser({
            callbacks: {
              onArtifactOpen: (data) => {
                logger.debug(`[Parser Debug] Artifact opened: ${data.id}, ${data.title}`);
              },
              onActionOpen: (data) => {
                logger.debug(`[Parser Debug] Action opened: ${data.action.type}, filePath: ${(data.action as any).filePath || 'N/A'}`);
              },
              onActionClose: (data) => {
                logger.debug(`[Parser Debug] Action closed: ${data.action.type}`);
              },
              onArtifactClose: (data) => {
                logger.debug(`[Parser Debug] Artifact closed: ${data.id}`);
              }
            }
          });
          parserInstanceCache.set(chatId, initialParser);
          logger.info(`Initialized parser for new chat ${chatId}`);
        }
        
        // Modificar as opções para incluir o ID da conversa 
        const enhancedOptions: StreamingOptions = {
          ...options,
          chatId: chatId, // Passar o ID da conversa para permitir acesso ao parser correto
        };
        
        const result = await streamText({
          messages,
          env: context.cloudflare?.env,
          options: enhancedOptions, // Usar opções melhoradas com chatId
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          contextFiles: filteredFiles,
          summary,
          messageSliceId,
        });

        (async () => {
          for await (const part of result.fullStream) {
            if (part.type === 'error') {
              const error: any = part.error;
              logger.error(`${error}`);

              return;
            }
          }
        })();
        result.mergeIntoDataStream(dataStream);
      },
      onError: (error: any) => `Custom error: ${error.message}`,
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          // Inicializa lastChunk se for a primeira execução
          if (!lastChunk) {
            lastChunk = ' ';
          }

          // Detecta início e fim de seções de pensamento (thought)
          if (typeof chunk === 'string') {
            // Se estamos começando uma seção de pensamento
            if (chunk.startsWith('g') && !lastChunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "<div class=\\"__boltThought__\\">"\n`));
            }

            // Se estamos terminando uma seção de pensamento
            if (lastChunk.startsWith('g') && !chunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
            }
          }

          // Guarda o chunk atual para a próxima iteração
          lastChunk = chunk;

          let transformedChunk = chunk;

          // Transforma chunks de pensamento (g:) em chunks normais (0:)
          if (typeof chunk === 'string' && chunk.startsWith('g')) {
            let content = chunk.split(':').slice(1).join(':');

            if (content.endsWith('\n')) {
              content = content.slice(0, content.length - 1);
            }

            transformedChunk = `0:${content}\n`;
          } 
          // Garante que qualquer chunk que não tenha um prefixo receba um prefixo '0:'
          else if (typeof chunk === 'string' && !chunk.startsWith('0:') && !chunk.startsWith('1:') && 
                  !chunk.startsWith('2:') && chunk.trim().length > 0) {
            transformedChunk = `0:${chunk}\n`;
            logger.debug(`Fixed unprefixed chunk: ${chunk.substring(0, 30)}...`);
          }

          // Convert the string stream to a byte stream
          const str = typeof transformedChunk === 'string' ? transformedChunk : JSON.stringify(transformedChunk);
          controller.enqueue(encoder.encode(str));
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(error);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
