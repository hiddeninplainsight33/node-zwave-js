import { ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";
import { getEnumMemberName } from "@zwave-js/shared";
import {
	assign,
	DefaultContext,
	EventObject,
	Interpreter,
	InterpreterOptions,
	Machine,
	SendAction,
	spawn,
	StateMachine,
	StateSchema,
	Typestate,
} from "xstate";
import { respond } from "xstate/lib/actions";
import {
	SendDataAbort,
	SendDataMulticastRequest,
	SendDataMulticastRequestTransmitReport,
	SendDataRequest,
	SendDataRequestTransmitReport,
	TransmitStatus,
} from "../controller/SendDataMessages";
import type { Message } from "../message/Message";
import type { SendDataErrorData } from "./SendThreadMachine";
import type { SerialAPICommandEvent } from "./SerialAPICommandMachine";
import type { Transaction } from "./Transaction";

export interface ServiceImplementations {
	timestamp: () => number;
	sendData: (data: Buffer) => Promise<void>;
	createSendDataAbort: () => SendDataAbort;
	notifyRetry?: (
		command: "SendData" | "SerialAPI",
		message: Message,
		attempts: number,
		maxAttempts: number,
		delay: number,
	) => void;
	notifyUnsolicited: (message: Message) => void;
	rejectTransaction: (transaction: Transaction, error: ZWaveError) => void;
	resolveTransaction: (transaction: Transaction, result?: Message) => void;
}

export function sendDataErrorToZWaveError(
	error: SendDataErrorData["reason"],
	transaction: Transaction,
	receivedMessage: Message | undefined,
): ZWaveError {
	switch (error) {
		case "send failure":
		case "CAN":
		case "NAK":
			return new ZWaveError(
				`Failed to send the message after 3 attempts. ${transaction.stack}`,
				ZWaveErrorCodes.Controller_MessageDropped,
			);
		case "ACK timeout":
			return new ZWaveError(
				`Timeout while waiting for an ACK from the controller. ${transaction.stack}`,
				ZWaveErrorCodes.Controller_Timeout,
			);
		case "response timeout":
			return new ZWaveError(
				`Timeout while waiting for a response from the controller. ${transaction.stack}`,
				ZWaveErrorCodes.Controller_Timeout,
			);
		case "callback timeout":
			return new ZWaveError(
				`Timeout while waiting for a callback from the controller. ${transaction.stack}`,
				ZWaveErrorCodes.Controller_Timeout,
			);
		case "response NOK":
			if (
				transaction.message instanceof SendDataRequest ||
				transaction.message instanceof SendDataMulticastRequest
			) {
				return new ZWaveError(
					`Failed to send the command after ${transaction.message.maxSendAttempts} attempts. Transmission queue full. ${transaction.stack}`,
					ZWaveErrorCodes.Controller_MessageDropped,
					receivedMessage,
				);
			} else {
				return new ZWaveError(
					`The controller response indicated failure. ${transaction.stack}`,
					ZWaveErrorCodes.Controller_ResponseNOK,
					receivedMessage,
				);
			}
		case "callback NOK":
			if (transaction.message instanceof SendDataRequest) {
				const status = (receivedMessage as SendDataRequestTransmitReport)
					.transmitStatus;
				return new ZWaveError(
					`Failed to send the command after ${
						transaction.message.maxSendAttempts
					} attempts (Status ${getEnumMemberName(
						TransmitStatus,
						status,
					)}). ${transaction.stack}`,
					status === TransmitStatus.NoAck
						? ZWaveErrorCodes.Controller_CallbackNOK
						: ZWaveErrorCodes.Controller_MessageDropped,
					receivedMessage,
				);
			} else if (
				transaction.message instanceof SendDataMulticastRequest
			) {
				const status = (receivedMessage as SendDataMulticastRequestTransmitReport)
					.transmitStatus;
				return new ZWaveError(
					`One or more nodes did not respond to the multicast request (Status ${getEnumMemberName(
						TransmitStatus,
						status,
					)}). ${transaction.stack}`,
					status === TransmitStatus.NoAck
						? ZWaveErrorCodes.Controller_CallbackNOK
						: ZWaveErrorCodes.Controller_MessageDropped,
					receivedMessage,
				);
			} else {
				return new ZWaveError(
					`The controller callback indicated failure. ${transaction.stack}`,
					ZWaveErrorCodes.Controller_CallbackNOK,
					receivedMessage,
				);
			}
		case "node timeout":
			return new ZWaveError(
				`Timed out while waiting for a response from the node. ${transaction.stack}`,
				ZWaveErrorCodes.Controller_NodeTimeout,
				receivedMessage,
			);
	}
}

/** Tests whether the given error is one that was caused by the serial API execution */
export function isSerialCommandError(error: unknown): boolean {
	if (!(error instanceof ZWaveError)) return false;
	switch (error.code) {
		case ZWaveErrorCodes.Controller_Timeout:
		case ZWaveErrorCodes.Controller_ResponseNOK:
		case ZWaveErrorCodes.Controller_CallbackNOK:
		case ZWaveErrorCodes.Controller_MessageDropped:
			return true;
	}
	return false;
}

export const respondUnsolicited: SendAction<any, any, any> = respond(
	(_: any, evt: SerialAPICommandEvent & { type: "message" }) => ({
		type: "unsolicited",
		message: evt.message,
	}),
);

/** Creates an auto-forwarding wrapper state machine that can be used to test machines that use sendParent */
export function createWrapperMachine(
	testMachine: StateMachine<any, any, any>,
): StateMachine<any, any, any> {
	return Machine<any, any, any>({
		context: {
			child: undefined,
		},
		initial: "main",
		states: {
			main: {
				entry: assign({
					child: () =>
						spawn(testMachine, {
							name: "child",
							autoForward: true,
						}),
				}),
			},
		},
	});
}

export type ExtendedInterpreter<
	TContext = DefaultContext,
	TStateSchema extends StateSchema = any,
	TEvent extends EventObject = EventObject,
	TTypestate extends Typestate<TContext> = { value: any; context: TContext }
> = Interpreter<TContext, TStateSchema, TEvent, TTypestate> & {
	restart(): Interpreter<TContext, TStateSchema, TEvent, TTypestate>;
};
export type Extended<
	TInterpreter extends Interpreter<any, any, any, any>
> = TInterpreter extends Interpreter<infer A, infer B, infer C, infer D>
	? ExtendedInterpreter<A, B, C, D>
	: never;

/** Extends the default xstate interpreter with a restart function that re-attaches all event handlers */
export function interpretEx<
	TContext = DefaultContext,
	TStateSchema extends StateSchema = any,
	TEvent extends EventObject = EventObject,
	TTypestate extends Typestate<TContext> = { value: any; context: TContext }
>(
	machine: StateMachine<TContext, TStateSchema, TEvent, TTypestate>,
	options?: Partial<InterpreterOptions>,
): ExtendedInterpreter<TContext, TStateSchema, TEvent, TTypestate> {
	const interpreter = new Interpreter<
		TContext,
		TStateSchema,
		TEvent,
		TTypestate
	>(machine, options) as ExtendedInterpreter<
		TContext,
		TStateSchema,
		TEvent,
		TTypestate
	>;

	return new Proxy(interpreter, {
		get(target, key) {
			if (key === "restart") {
				return () => {
					const listeners = [...(target["listeners"] as Set<any>)];
					const contextListeners = [
						...(target["contextListeners"] as Set<any>),
					];
					const stopListeners = [
						...(target["stopListeners"] as Set<any>),
					];
					const doneListeners = [
						...(target["doneListeners"] as Set<any>),
					];
					const eventListeners = [
						...(target["eventListeners"] as Set<any>),
					];
					const sendListeners = [
						...(target["sendListeners"] as Set<any>),
					];
					target.stop();
					for (const listener of listeners)
						target.onTransition(listener);
					for (const listener of contextListeners)
						target.onChange(listener);
					for (const listener of stopListeners)
						target.onStop(listener);
					for (const listener of doneListeners)
						target.onDone(listener);
					for (const listener of eventListeners)
						target.onEvent(listener);
					for (const listener of sendListeners)
						target.onSend(listener);
					return target.start();
				};
			} else {
				return (target as any)[key];
			}
		},
	});
}
