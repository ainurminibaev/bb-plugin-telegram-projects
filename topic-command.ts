import type {Conversation} from "./archive-access";

// The agent's ordinary work with forum topics, by request in words: create, rename, close, reopen, delete.
// Who may do what follows the calling conversation:
// - the owner's conversation: any group the bot is in;
// - a group: its own topics; deleting stays with the owner;
// - a person's private chat: nothing.
export type TopicAction="create"|"rename"|"close"|"reopen"|"delete";
export const TOPIC_ACTIONS:TopicAction[]=["create","rename","close","reopen","delete"];

/** Undefined when allowed, otherwise the reason. */
export function topicRefusal(caller:Conversation|undefined,action:TopicAction,chat:number):string|undefined {
  if (!caller) return "topic_only_from_a_telegram_conversation";
  if (caller.kind==="owner") return;
  if (caller.kind==="person") return "topics_not_available_in_a_private_chat";
  if (caller.chat!==chat) return "topic_of_another_group_not_allowed";
  if (action==="delete") return "deleting_a_topic_is_for_the_owner: ask the owner";
}
