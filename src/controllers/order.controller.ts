import express from "express";
import { ErrorEnum } from "../errors/httpErrors";
import { Food } from "../models/foods";
import { Order, OrderStatus } from "../models/orders";
import { OrderDetail } from "../models/order_details";
import { OrderPlace } from "../models/order_places";
import { Place } from "../models/places";
import { User } from "../models/users";
import sequelize from "../util/db";
import { OrderDetailCreateModel, OrderPlaceCreateModel } from "../util/parametersInterface";
import { messageFactory, MessageType } from "../websockets/messageFactory";
import { executedOrderStream$ } from "../websockets/server.websocket";


/**
 * Function that creates an order by using details provided in the request's body
 * @param req express.Request
 * @param res express.Response
 * @param next express.NextFunction
 */
export async function createOrder(req: express.Request, res: express.Response, next: express.NextFunction) {
    // We use a transaction to ensure to not insert "partial" orders in case of failure
    const transaction = await sequelize.transaction();
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) {
            transaction.rollback();
            return next(ErrorEnum.INTERNAL_SERVER_ERROR);
        }
        const places: OrderPlaceCreateModel[] = req.body.places;
        const foods: OrderDetailCreateModel[] = req.body.foods;

        let sumWithdrawal: number = 0;
        let sumDeliver: number = 0;

        let order = await Order.create({
            status: OrderStatus.CREATED,
            userId: user?.id
        }, { transaction: transaction });

        for (const food of foods) {
            let f = await Food.findOne({ where: { name: food.name } });
            if (f === null) {
                await transaction.rollback();
                return next(ErrorEnum.PARAM_NOT_VALID);
            }
            await OrderDetail.create({
                orderUuid: order.uuid,
                quantity: food.quantity,
                foodId: f.id,
                withdrawal_order: food.withdrawal_order
            }, { transaction: transaction });
            sumWithdrawal += food.quantity;
        }

        for (const place of places) {
            let p = await Place.findOne({ where: { name: place.name } });
            if (p === null) {
                await transaction.rollback();
                return next(ErrorEnum.PARAM_NOT_VALID);
            }
            await OrderPlace.create({
                orderUuid: order.uuid,
                placeId: p.id,
                quantity_to_deliver: place.quantity_to_deliver,
            }, { transaction: transaction });
            sumDeliver += place.quantity_to_deliver;
        }

        if (sumDeliver !== sumWithdrawal) {
            await transaction.rollback();
            return next(ErrorEnum.QUANTITIES_DO_NOT_MATCH);
        }

        await transaction.commit();
        res.status(201).json({ message: "Order created" });
    } catch (error) {
        await transaction.rollback();
        next(error);
    }

}


/**
 * Fetches all the orders in the db including informations about food and places
 * @param req express.Request
 * @param res express.Response
 * @param next express.NextFunction 
 * @returns all the orders from the db
 */
export async function getAllOrders(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const allOrders = await Order.findAll({ include: [{ model: Food }, { model: Place }] });
        return res.status(200).json(allOrders);
    } catch (error) {
        next(error);
    }
}

/**
 * Fetches the order with the specified UUID
 * @param req express.Request
 * @param res express.Response
 * @param next express.NextFunction
 * @returns the order found
 */
export async function getOrderByUuid(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const order = await Order.findOne({ where: { uuid: req.params.uuid }, include: [{ model: Food }, { model: Place }] });
        if (!order) return next(ErrorEnum.ORDER_NOT_FOUND);
        return res.status(200).json(order);
    } catch (error) {
        next(error);
    }
}

/**
 * Fetches the order with the specified UUID
 * @param req express.Request
 * @param res express.Response
 * @param next express.NextFunction
 * @returns the status of the order
 */
export async function getOrderStatus(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const order = await Order.findOne({ where: { uuid: req.params.uuid } });
        if (!order) return next(ErrorEnum.ORDER_NOT_FOUND);
        let status = "";
        switch (order.status) {
            case OrderStatus.CREATED:
                status = "Created";
                break;
            case OrderStatus.FAILED:
                status = "Failed";
                break;
            case OrderStatus.RUNNING:
                status = "Running";
                break;
            case OrderStatus.COMPLETED:
                status = "Completed";
                break;
        }
        return res.status(200).json({ status: status });
    } catch (error) {
        next(error);
    }
}

/**
 * Starts the execution of the order with the uuid specified in the endpoint.
 * It calls next on the `executedOrderStream$` subject. 
 * @param req express.Request
 * @param res express.Response
 * @param next express.NextFunction
 * @returns 
 */
export async function executeOrder(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
        const order = await Order.findByPk(req.params.uuid, {include: [{model: Food}, {model: Place}]});
        
        if (!order) return next(ErrorEnum.ORDER_NOT_FOUND);
        if (order.status != OrderStatus.CREATED) return next(ErrorEnum.ORDER_ALREADY_STARTED);

        if(!executedOrderStream$.observed) return next(ErrorEnum.WS_NOT_AVAILABLE);
        // Here we're ignoring the error because `order.toJSON()` contains all the necessary values,
        // because we have included them before in the query.
        //@ts-ignore
        executedOrderStream$.next(messageFactory.getMessage(MessageType.EXECUTE_ORDER, order.uuid, {...order.toJSON()}));
        return res.status(200).json({ message: "Order started succesfully" });

    } catch (error) {
        next(error);
    }
}

/**
 * Updates the order with the uuid and status specified
 * @param uuid the uuid of the order to update
 * @param status the new status
 */
export async function updateOrderStatus(uuid: string, status: OrderStatus) {
    console.log(`Updating status of order ${uuid}, with status ${status}`);
    const order = await Order.findByPk(uuid);
    await order!.update({status: status});
}